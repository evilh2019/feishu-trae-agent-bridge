const vscode = require('vscode');
const { spawn, execFile } = require('child_process');
const fs = require('fs');
const path = require('path');

let outputChannel;

// ========== 可配置项 ==========
// 用户需修改以下配置适配自己的环境
const CONFIG = {
  // lark-cli 路径（留空自动探测 Trae 安装路径）
  LARK_CLI: '',
  // lark-cli profile 名称（通过 lark-cli config 命令配置）
  LARK_PROFILE: 'xiaot1',
  // 飞书用户 open_id（从飞书开放平台获取，格式: ou_xxx）
  FEISHU_USER_ID: '',
  // Bridge 工作目录（留空使用用户主目录下的 trae-feishu-bridge）
  WORK_DIR: '',
  // lark-cli event consume 超时（默认 3600s = 1 小时）
  BRIDGE_TIMEOUT: '3600s',
};

// ========== 自动探测 lark-cli ==========
function findLarkCli() {
  if (CONFIG.LARK_CLI && fs.existsSync(CONFIG.LARK_CLI)) {
    return CONFIG.LARK_CLI;
  }
  const os = require('os');
  const candidates = [
    process.env.LARK_CLI_PATH,
    path.join(os.homedir(), '.trae-cn', 'plugins', 'trae-remote-official', 'lark', 'bin', 'lark-cli.exe'),
    path.join(os.homedir(), '.trae-cn', 'plugins', 'lark', 'bin', 'lark-cli.exe'),
    path.join(process.env.LOCALAPPDATA || '', 'Trae CN', 'resources', 'app', 'plugins', 'lark', 'bin', 'lark-cli.exe'),
  ].filter(Boolean);
  for (const p of candidates) {
    if (fs.existsSync(p)) return p;
  }
  return null;
}

// ========== 初始化配置 ==========
function initPaths() {
  const os = require('os');
  const workDir = CONFIG.WORK_DIR || path.join(os.homedir(), 'trae-feishu-bridge');
  if (!fs.existsSync(workDir)) fs.mkdirSync(workDir, { recursive: true });
  const repliesDir = path.join(workDir, 'replies');
  if (!fs.existsSync(repliesDir)) fs.mkdirSync(repliesDir, { recursive: true });

  return {
    LARK_CLI: findLarkCli(),
    LARK_PROFILE: CONFIG.LARK_PROFILE,
    FEISHU_USER_ID: CONFIG.FEISHU_USER_ID,
    REPLIES_DIR: repliesDir,
    SESSION_STATE_FILE: path.join(workDir, 'session_state.json'),
    BRIDGE_TIMEOUT: CONFIG.BRIDGE_TIMEOUT,
    LOG_FILE: path.join(workDir, 'bridge.log'),
    WORK_DIR: workDir,
  };
}

let PATHS; // 运行时配置，由 activate() 初始化

let bridgeProcess = null;
let isBridgeRunning = false;
let processedEventIds = new Set();  // 事件去重
let messageQueue = [];  // 消息处理队列
let isProcessing = false;  // 是否正在处理消息
let replyWatcher = null;  // fs.watch 目录监听器
let watchDetectedFiles = new Set();  // fs.watch 检测到的待处理文件
let timingMap = new Map();  // 消息各阶段时间戳 { messageId: { t0, t1, t2, ... } }

// ========== 飞书持久 Session 管理 ==========
let feishuSessionId = null;        // 飞书桥专用 session ID
let feishuSessionLastUsed = 0;      // session 最后使用时间戳
const SESSION_RESET_TIMEOUT = 30 * 60 * 1000;  // 30 分钟无消息自动重置
const SESSION_RESET_COMMANDS = ['/新对话', '/reset', '/new', '/重置对话'];

function log(msg) {
  const ts = new Date().toLocaleTimeString('zh-CN', { hour12: false });
  const line = `[${ts}] ${msg}`;
  outputChannel.appendLine(line);
  try {
    if (PATHS) {
      fs.appendFileSync(PATHS.LOG_FILE, line + '\n');
    }
  } catch (e) { /* 忽略 */ }
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function withTimeout(promise, ms) {
  return Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error(`Timeout after ${ms}ms`)), ms))
  ]);
}

async function healthCheck() {
  log('=== 健康检查 ===');
  log(`VSCode 版本: ${vscode.version}`);

  const criticalCommands = [
    'workbench.action.chat.toggle',
    'workbench.action.chat.submit',
    'workbench.action.chat.newChat',
    'workbench.action.chat.clear',
    'editor.action.clipboardPasteAction',
  ];

  log('');
  log('--- 关键命令存在性检查 ---');
  const allCommands = await vscode.commands.getCommands(true);
  for (const cmd of criticalCommands) {
    const exists = allCommands.includes(cmd);
    log(`  ${exists ? '[OK]' : '[MISSING]'} ${cmd}`);
  }

  log('');
  log('--- chat 相关命令（含 trae） ---');
  const chatCmds = allCommands.filter(c => /chat/i.test(c));
  log(`  共 ${chatCmds.length} 个 chat 相关命令:`);
  chatCmds.sort().forEach(c => log(`    - ${c}`));

  log('');
  log('=== 健康检查完成 ===');
  outputChannel.show(true);
  vscode.window.showInformationMessage('XiaoT1 Bridge: 健康检查完成，查看 Output 面板');
}

async function testIcubeSend() {
  log('=== 测试 icube 原生 API ===');

  const testMessage = '[xiaot1-bridge icube 测试] 请回复 pong';

  try {
    log(`测试消息: "${testMessage}"`);
    log('');

    log('[1/6] 获取初始 session ID...');
    let sessionId = await vscode.commands.executeCommand('icube.chat.getCurrentSessionId');
    log(`  当前 session: ${sessionId || '(无)'}`);

    log('[2/6] 发送消息 via icube.chat.sendToAgentNonBlocking...');
    log(`  inputs: ["${testMessage}"]`);
    log(`  选项: newSession=true (创建独立 session 避免干扰当前对话)`);
    const sendResult = await vscode.commands.executeCommand(
      'icube.chat.sendToAgentNonBlocking',
      [testMessage],
      { enableUnstableFields: true, newSession: true }
    );
    log(`  发送结果: ${JSON.stringify(sendResult)?.substring(0, 300)}`);

    log('[3/6] 获取新 session ID...');
    sessionId = await vscode.commands.executeCommand('icube.chat.getCurrentSessionId');
    log(`  新 session: ${sessionId || '(无)'}`);

    log('[4/6] 轮询 getSessionRunningStatus 等待回复...');
    const maxWait = 90000;
    const startTime = Date.now();
    let status = null;
    let pollCount = 0;
    let lastStatus = null;

    while (Date.now() - startTime < maxWait) {
      await sleep(500);
      pollCount++;
      try {
        status = await vscode.commands.executeCommand('icube.chat.getSessionRunningStatus');
        if (status !== lastStatus) {
          log(`  [轮询 ${pollCount}] status=${status}, elapsed=${Date.now() - startTime}ms`);
          lastStatus = status;
        }
        if (status === 'WaitingInput' || status === 'Idle') {
          log(`  回复完成! status=${status}`);
          break;
        }
      } catch (e) {
        if (pollCount <= 3) log(`  [轮询 ${pollCount}] 错误: ${e.message}`);
      }
    }

    if (Date.now() - startTime >= maxWait) {
      log(`  [超时] 90秒内未完成, 最后状态: ${status}`);
    }

    log('[5/6] 尝试获取回复内容...');
    try {
      const debugInfo = await vscode.commands.executeCommand('icube.chat.copyLastTurnDebugInfo');
      log(`  copyLastTurnDebugInfo: ${JSON.stringify(debugInfo)?.substring(0, 500)}`);
    } catch (e) {
      log(`  copyLastTurnDebugInfo 失败: ${e.message}`);
    }

    log('[6/6] 再次获取 session ID...');
    sessionId = await vscode.commands.executeCommand('icube.chat.getCurrentSessionId');
    log(`  最终 session: ${sessionId || '(无)'}`);

    log('');
    log('=== icube 测试完成 ===');
    log('请检查 chat 面板是否有测试消息和回复');
    outputChannel.show(true);
    vscode.window.showInformationMessage('XiaoT1 Bridge: icube 测试完成，查看 Output');

  } catch (error) {
    log(`[ERROR] ${error.message}`);
    if (error.stack) log(error.stack);
    outputChannel.show(true);
    vscode.window.showErrorMessage(`icube 测试失败: ${error.message}`);
  }
}

async function probeApis() {
  log('=== 探测可用 API ===');
  log('');

  // 1. 枚举所有 icube.* 命令
  log('--- [1] 所有 icube.* 命令 ---');
  const allCmds = await vscode.commands.getCommands(true);
  const icubeCmds = allCmds.filter(c => c.startsWith('icube.')).sort();
  log(`  共 ${icubeCmds.length} 个 icube.* 命令:`);
  icubeCmds.forEach(c => log(`    - ${c}`));
  log('');

  // 2. 重点探测 chat 相关的"读取类"命令（无副作用）
  log('--- [2] 尝试调用读取类 icube.chat.* 命令 ---');
  const readCmds = [
    'icube.chat.getCurrentSessionId',
    'icube.chat.getHistory',
    'icube.chat.getMessages',
    'icube.chat.getLastReply',
    'icube.chat.getLastTurn',
    'icube.chat.getLastMessage',
    'icube.chat.getConversation',
    'icube.chat.getSession',
    'icube.chat.getSessionInfo',
    'icube.chat.listSessions',
    'icube.chat.getAllSessions',
    'icube.chat.getRunningStatus',
    'icube.chat.getSessionRunningStatus',
    'icube.chat.copyLastTurnDebugInfo',
    'icube.chat.getLastTurnDebugInfo',
    'icube.chat.export',
    'icube.chat.exportSession',
    'icube.chat.getReply',
    'icube.chat.getResponse',
  ];
  for (const cmd of readCmds) {
    try {
      const result = await vscode.commands.executeCommand(cmd);
      const str = JSON.stringify(result);
      log(`  [OK] ${cmd}: ${str ? str.substring(0, 200) : '(undefined)'}`);
    } catch (e) {
      log(`  [FAIL] ${cmd}: ${e.message.substring(0, 100)}`);
    }
  }
  log('');

  // 3. 尝试带参数的读取命令（用当前 session ID）
  log('--- [3] 带 session ID 尝试读取 ---');
  const sessionId = await vscode.commands.executeCommand('icube.chat.getCurrentSessionId');
  log(`  当前 session: ${sessionId}`);
  if (sessionId) {
    const paramCmds = [
      'icube.chat.getHistory',
      'icube.chat.getMessages',
      'icube.chat.getSession',
      'icube.chat.getSessionInfo',
      'icube.chat.getConversation',
      'icube.chat.export',
      'icube.chat.exportSession',
      'icube.chat.copySession',
      'icube.chat.readSession',
    ];
    for (const cmd of paramCmds) {
      // 尝试不同的参数形式
      const argVariants = [
        [sessionId],
        [{ sessionId }],
        [{ id: sessionId }],
        [sessionId, { limit: 10 }],
      ];
      for (const args of argVariants) {
        try {
          const result = await vscode.commands.executeCommand(cmd, ...args);
          const str = JSON.stringify(result);
          if (str && str !== 'null' && str !== 'undefined') {
            log(`  [OK] ${cmd}(${JSON.stringify(args).substring(0, 80)}): ${str.substring(0, 200)}`);
            break;
          }
        } catch (e) {
          // 静默
        }
      }
    }
  }
  log('');

  // 4. 探测 webview 相关
  log('--- [4] webview 相关探测 ---');
  const webviewCmds = allCmds.filter(c => /webview|chat.*view|view.*chat/i.test(c));
  log(`  webview 相关命令 (${webviewCmds.length}):`);
  webviewCmds.sort().forEach(c => log(`    - ${c}`));
  log('');

  // 5. 探测 output channel 相关
  log('--- [5] output channel 命令 ---');
  const outputCmds = allCmds.filter(c => /output|log/i.test(c) && /chat|trae|agent/i.test(c));
  log(`  output/log + chat 相关命令 (${outputCmds.length}):`);
  outputCmds.sort().forEach(c => log(`    - ${c}`));
  log('');

  // 6. 尝试访问 vscode.window 的 webview 相关 API
  log('--- [6] vscode.window API 探测 ---');
  const windowKeys = Object.keys(vscode.window).filter(k => /chat|webview|view|tab/i.test(k));
  log(`  vscode.window 相关属性: ${windowKeys.join(', ') || '(无)'}`);

  // 检查 window.tabGroups
  if (vscode.window.tabGroups) {
    try {
      const tabs = vscode.window.tabGroups.all;
      log(`  tabGroups: ${tabs.length} 个 group`);
      for (const group of tabs) {
        log(`    group: ${group.viewColumn}, ${group.tabs.length} tabs`);
        for (const tab of group.tabs) {
          const label = tab.label || '';
          const input = tab.input;
          const inputType = input ? input.constructor?.name || typeof input : 'null';
          log(`      - "${label}" (input: ${inputType})`);
          // 如果是 webview tab，尝试获取 webview
          if (input && typeof input === 'object') {
            const inputKeys = Object.keys(input);
            log(`        input keys: ${inputKeys.join(', ')}`);
            if (input.viewType || input.webview) {
              log(`        viewType: ${input.viewType}, has webview: ${!!input.webview}`);
            }
          }
        }
      }
    } catch (e) {
      log(`  tabGroups 探测失败: ${e.message}`);
    }
  }
  log('');

  // 7. 探测 icube 其他模块
  log('--- [7] icube 非聊天模块（可能有上下文/历史相关） ---');
  const icubeOther = icubeCmds.filter(c => !c.startsWith('icube.chat.'));
  const categories = {};
  icubeOther.forEach(c => {
    const cat = c.split('.').slice(0, 2).join('.');
    if (!categories[cat]) categories[cat] = [];
    categories[cat].push(c);
  });
  Object.keys(categories).sort().forEach(cat => {
    log(`  ${cat} (${categories[cat].length}):`);
    categories[cat].forEach(c => log(`    - ${c}`));
  });
  log('');

  // === 追加 webview 深度探测 ===
  log('');
  log('--- [8] webview 深度探测 ---');
  log('');

  // [8a] webview/view 相关命令
  log('  [8a] webview/view 相关命令:');
  const wvCmds = allCmds.filter(c => /webview|chatView|chat\.view|chat.*panel|panel.*chat/i.test(c)).sort();
  log(`    共 ${wvCmds.length} 个:`);
  wvCmds.forEach(c => log(`      - ${c}`));
  log('');

  // [8b] icube.webview.sendCommand 参数探索（加 3s 超时防卡死）
  log('  [8b] icube.webview.sendCommand 参数探索:');
  const sendCmd = 'icube.webview.sendCommand';
  const trials = [
    { label: '无参数', args: [] },
    { label: '字符串', args: ['test'] },
    { label: 'viewType 字符串', args: ['chat'] },
    { label: '对象 {command}', args: [{ command: 'ping' }] },
    { label: '对象 {viewType, command}', args: [{ viewType: 'chat', command: 'ping' }] },
    { label: '对象 {id, command}', args: [{ id: 'chat', command: 'ping' }] },
    { label: '对象 {viewId, command}', args: [{ viewId: 'chat', command: 'ping' }] },
    { label: '两参数 字符串,字符串', args: ['chat', 'ping'] },
    { label: '两参数 字符串,对象', args: ['chat', { command: 'ping' }] },
    { label: '三参数', args: ['chat', 'ping', {}] },
  ];
  for (const t of trials) {
    try {
      const r = await withTimeout(vscode.commands.executeCommand(sendCmd, ...t.args), 3000);
      log(`    [OK] ${t.label}: ${JSON.stringify(r)?.substring(0, 150) || '(undefined)'}`);
    } catch (e) {
      const msg = (e.message || String(e)).substring(0, 150);
      if (msg.includes('timeout') || msg.includes('Timeout')) {
        log(`    [TIMEOUT] ${t.label}: 3s 超时（命令可能卡死）`);
      } else {
        log(`    [FAIL] ${t.label}: ${msg}`);
      }
    }
  }
  log('');

  // [8c] 尝试常见 chat webview viewType
  log('  [8c] 查找 chat webview viewType:');
  const possibleViewTypes = [
    'chat', 'workbench.chat', 'workbench.panel.chat',
    'icube.chat', 'icube.chatView', 'icube.ai.chat',
    'trae.chat', 'trae.panel.chat', 'workbench.view.chat',
    'workbench.view.extension.chat',
  ];
  for (const vt of possibleViewTypes) {
    try {
      const r = await withTimeout(vscode.commands.executeCommand('icube.webview.sendCommand', vt, 'ping'), 3000);
      log(`    [OK] viewType="${vt}": ${JSON.stringify(r)?.substring(0, 100) || '(undefined)'}`);
    } catch (e) {
      const msg = (e.message || String(e)).substring(0, 120);
      if (!/not found|no such|invalid|cannot/i.test(msg)) {
        log(`    [?] viewType="${vt}": ${msg}`);
      }
    }
  }
  log('');

  // [8d] workbench.view.* 命令
  log('  [8d] workbench.view.* 命令:');
  const viewCmds = allCmds.filter(c => c.startsWith('workbench.view.')).sort();
  log(`    共 ${viewCmds.length} 个:`);
  viewCmds.forEach(c => log(`      - ${c}`));
  log('');

  // [8e] icube 中含 history/export/get/list/read 的命令
  log('  [8e] icube 中含 history/export/get/list/read 的命令:');
  const historyCmds = allCmds
    .filter(c => c.startsWith('icube.') && /history|export|get.*message|get.*reply|list.*session|read|snapshot/i.test(c))
    .sort();
  log(`    共 ${historyCmds.length} 个:`);
  historyCmds.forEach(c => log(`      - ${c}`));
  log('');

  // [8f] icube.chat.recordReplay 探索
  log('  [8f] icube.chat.recordReplay 探索:');
  const rrCmds = allCmds.filter(c => c.startsWith('icube.chat.recordReplay')).sort();
  log(`    命令: ${rrCmds.join(', ') || '(无)'}`);
  for (const cmd of rrCmds) {
    try {
      const r = await vscode.commands.executeCommand(cmd);
      log(`    [OK] ${cmd}: ${JSON.stringify(r)?.substring(0, 200) || '(undefined)'}`);
    } catch (e) {
      log(`    [FAIL] ${cmd}: ${e.message.substring(0, 100)}`);
    }
  }
  log('');

  // [8g] chat snapshot 相关
  log('  [8g] chat snapshot 相关:');
  try {
    const r = await vscode.commands.executeCommand('icube.common.commands.tooling.applyChatSnapshotPatch');
    log(`    [OK] applyChatSnapshotPatch: ${JSON.stringify(r)?.substring(0, 200) || '(undefined)'}`);
  } catch (e) {
    log(`    [FAIL] applyChatSnapshotPatch: ${(e.message || String(e)).substring(0, 120)}`);
  }
  log('');

  // [9] icube.imBridge.feishu.* 探测（Trae 内置飞书桥！）
  log('  [9] icube.imBridge.feishu.* 探测:');
  const feishuCmds = allCmds.filter(c => c.startsWith('icube.imBridge.feishu')).sort();
  log(`    共 ${feishuCmds.length} 个:`);
  for (const cmd of feishuCmds) {
    const shortName = cmd.replace('icube.imBridge.feishu.', '');
    // 只读/查询类命令尝试调用
    if (/checkBound|getBot|getEvents|getSession|getWorkspace|listSession|getChannel|getEnabled|getGroup|resolveSession/.test(shortName)) {
      try {
        const r = await withTimeout(vscode.commands.executeCommand(cmd), 3000);
        log(`    [OK] ${shortName}: ${JSON.stringify(r)?.substring(0, 200) || '(undefined)'}`);
      } catch (e) {
        log(`    [FAIL] ${shortName}: ${(e.message || String(e)).substring(0, 120)}`);
      }
    } else {
      log(`    [SKIP] ${shortName} (写操作，跳过)`);
    }
  }
  log('');

  // [10] webview URL / DevTools 探测
  log('  [10] webview URL / DevTools 探测:');
  const wvUrlCmds = [
    'workbench.action.webview.getWebviewUrl',
    'workbench.action.webview.openDeveloperTools',
    'workbench.action.webview.reloadWebviewAction',
    'workbench.action.webview.onPortChanges',
    'workbench.action.openWebviewInBrowser',
  ];
  for (const cmd of wvUrlCmds) {
    try {
      const r = await withTimeout(vscode.commands.executeCommand(cmd), 3000);
      log(`    [OK] ${cmd}: ${JSON.stringify(r)?.substring(0, 200) || '(undefined)'}`);
    } catch (e) {
      log(`    [FAIL] ${cmd}: ${(e.message || String(e)).substring(0, 120)}`);
    }
  }
  log('');

  // [11] icube.component.sendMessage 探测
  log('  [11] icube.component.sendMessage 探测:');
  try {
    const r = await withTimeout(vscode.commands.executeCommand('icube.component.sendMessage'), 3000);
    log(`    [OK] sendMessage: ${JSON.stringify(r)?.substring(0, 200) || '(undefined)'}`);
  } catch (e) {
    log(`    [FAIL] sendMessage: ${(e.message || String(e)).substring(0, 120)}`);
  }
  log('');

  log('=== 探测完成 ===');
  outputChannel.show(true);
  vscode.window.showInformationMessage('XiaoT1 Bridge: API 探测完成，查看 Output');
}

async function testChatSend() {
  log('=== 开始测试 chat 发送 (Clipboard Hack) ===');

  const testMessage = '[xiaot1-bridge MVP 测试] 请回复 pong';

  try {
    log(`测试消息: "${testMessage}"`);
    log('');

    log('[1/6] 打开 chat (workbench.action.chat.toggle)...');
    await vscode.commands.executeCommand('workbench.action.chat.toggle');
    await sleep(1200);
    log('  完成');

    log('[2/6] 写入剪贴板...');
    await vscode.env.clipboard.writeText(testMessage);
    await sleep(200);
    log('  完成');

    log('[3/6] 尝试聚焦 chat 输入框...');
    const focusCmds = [
      'workbench.action.chat.focusInput',
      'chat.focusInput',
      'workbench.action.focusChatInput',
    ];
    let focused = false;
    for (const cmd of focusCmds) {
      try {
        await vscode.commands.executeCommand(cmd);
        log(`  ${cmd} 成功`);
        focused = true;
        break;
      } catch (e) {
        // 命令不存在，继续尝试下一个
      }
    }
    if (!focused) {
      log('  未找到聚焦命令，依赖 chat 打开时自动聚焦');
    }
    await sleep(500);

    log('[4/6] 粘贴文本 (editor.action.clipboardPasteAction)...');
    await vscode.commands.executeCommand('editor.action.clipboardPasteAction');
    await sleep(600);
    log('  完成');

    log('[5/6] 提交 (workbench.action.chat.submit)...');
    await vscode.commands.executeCommand('workbench.action.chat.submit');
    log('  提交命令已发送');

    log('[6/6] 等待回复 (15秒)...');
    await sleep(15000);
    log('  等待结束');

    log('');
    log('=== 测试完成 ===');
    log('请检查 chat 面板是否有测试消息和回复');
    outputChannel.show(true);
    vscode.window.showInformationMessage('XiaoT1 Bridge: 测试完成，请检查 chat 面板');

  } catch (error) {
    log(`[ERROR] ${error.message}`);
    if (error.stack) log(error.stack);
    outputChannel.show(true);
    vscode.window.showErrorMessage(`XiaoT1 Bridge 测试失败: ${error.message}`);
  }
}

async function probeFeishuBridge() {
  log('=== 探测 Trae 原生飞书桥 ===');
  log('');

  // [1] 获取配置文件路径
  log('--- [1] getChannelConfigPath ---');
  let configFilePath = null;
  try {
    const r = await withTimeout(vscode.commands.executeCommand('icube.imBridge.getChannelConfigPath'), 3000);
    log(`  [OK] ${JSON.stringify(r) || '(undefined)'}`);
    // 返回的是对象 {dir, file, userId}
    if (r && typeof r === 'object' && r.file) {
      // file 是 URI 格式: file:///c%3A/Users/...
      const uri = decodeURIComponent(r.file);
      const fsPath = uri.replace(/^file:\/\//, '').replace(/^\//, '');
      configFilePath = fsPath;  // 先设置路径，即使文件不存在也需要
      log(`  配置文件路径: ${fsPath}`);
      try {
        const content = fs.readFileSync(fsPath, 'utf8');
        log(`  现有配置内容:\n${content}`);
      } catch (e) {
        log(`  [INFO] 配置文件不存在，需要创建 (${e.message.substring(0, 80)})`);
      }
    } else if (typeof r === 'string' && r.length > 0) {
      configFilePath = r;
      try {
        const content = fs.readFileSync(r, 'utf8');
        log(`  现有配置内容:\n${content}`);
      } catch (e) {
        log(`  [INFO] 配置文件不存在，需要创建 (${e.message.substring(0, 80)})`);
      }
    }
  } catch (e) {
    log(`  [FAIL] ${e.message.substring(0, 120)}`);
  }
  log('');

  // [2] 探测 login 参数签名（用错误信息反推）
  log('--- [2] feishu.login 参数探索 ---');
  const loginTrials = [
    { label: '无参数', args: [] },
    { label: '字符串', args: ['test'] },
    { label: '对象 {appId}', args: [{ appId: 'test' }] },
    { label: '对象 {app_id}', args: [{ app_id: 'test' }] },
    { label: '对象 {appId, appSecret}', args: [{ appId: 'test', appSecret: 'test' }] },
    { label: '对象 {app_id, app_secret}', args: [{ app_id: 'test', app_secret: 'test' }] },
    { label: '对象 {token}', args: [{ token: 'test' }] },
    { label: '对象 {credentials}', args: [{ credentials: { appId: 'test', appSecret: 'test' } }] },
  ];
  for (const t of loginTrials) {
    try {
      const r = await withTimeout(vscode.commands.executeCommand('icube.imBridge.feishu.login', ...t.args), 3000);
      log(`  [OK] ${t.label}: ${JSON.stringify(r)?.substring(0, 200) || '(undefined)'}`);
    } catch (e) {
      log(`  [FAIL] ${t.label}: ${(e.message || String(e)).substring(0, 150)}`);
    }
  }
  log('');

  // [3] 探测 reply 参数签名
  log('--- [3] feishu.reply 参数探索 ---');
  const replyTrials = [
    { label: '无参数', args: [] },
    { label: '字符串', args: ['test'] },
    { label: '对象 {message}', args: [{ message: 'test' }] },
    { label: '对象 {text}', args: [{ text: 'test' }] },
    { label: '对象 {content}', args: [{ content: 'test' }] },
    { label: '对象 {sessionId, text}', args: [{ sessionId: 'test', text: 'hello' }] },
    { label: '两参数 字符串,字符串', args: ['sessionId', 'text'] },
  ];
  for (const t of replyTrials) {
    try {
      const r = await withTimeout(vscode.commands.executeCommand('icube.imBridge.feishu.reply', ...t.args), 3000);
      log(`  [OK] ${t.label}: ${JSON.stringify(r)?.substring(0, 200) || '(undefined)'}`);
    } catch (e) {
      log(`  [FAIL] ${t.label}: ${(e.message || String(e)).substring(0, 150)}`);
    }
  }
  log('');

  // [4] 探测 streamStart 参数签名
  log('--- [4] feishu.streamStart 参数探索 ---');
  const streamTrials = [
    { label: '无参数', args: [] },
    { label: '字符串', args: ['test'] },
    { label: '对象 {sessionId}', args: [{ sessionId: 'test' }] },
    { label: '对象 {sessionId, text}', args: [{ sessionId: 'test', text: 'hello' }] },
  ];
  for (const t of streamTrials) {
    try {
      const r = await withTimeout(vscode.commands.executeCommand('icube.imBridge.feishu.streamStart', ...t.args), 3000);
      log(`  [OK] ${t.label}: ${JSON.stringify(r)?.substring(0, 200) || '(undefined)'}`);
    } catch (e) {
      log(`  [FAIL] ${t.label}: ${(e.message || String(e)).substring(0, 150)}`);
    }
  }
  log('');

  // [5] 探测 getEnabled / setEnabled
  log('--- [5] imBridge.getEnabled / setEnabled ---');
  try {
    const r = await withTimeout(vscode.commands.executeCommand('icube.imBridge.getEnabled'), 3000);
    log(`  [OK] getEnabled: ${JSON.stringify(r) || '(undefined)'}`);
  } catch (e) {
    log(`  [FAIL] getEnabled: ${e.message.substring(0, 120)}`);
  }
  // 尝试 setEnabled(true)
  log('  尝试 setEnabled(true):');
  try {
    const r = await withTimeout(vscode.commands.executeCommand('icube.imBridge.setEnabled', true), 3000);
    log(`    [OK] setEnabled(true): ${JSON.stringify(r) || '(undefined)'}`);
  } catch (e) {
    log(`    [FAIL] setEnabled(true): ${(e.message || String(e)).substring(0, 150)}`);
  }
  log('');

  // [5b] 如果有配置文件，写入真实凭据并启用桥
  if (configFilePath) {
    log('--- [5b] 写入真实飞书配置并启用桥 ---');
    // 使用 WSL .env 中的凭据
    const realConfig = {
      appId: 'APP_ID_REDACTED',
      appSecret: 'APP_SECRET_REDACTED',
      brand: 'feishu',
      enabled: true
    };
    try {
      const path = require('path');
      const dir = path.dirname(configFilePath);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
        log(`  [INFO] 已创建目录: ${dir}`);
      }
      fs.writeFileSync(configFilePath, JSON.stringify(realConfig, null, 2), 'utf8');
      log(`  [OK] 配置文件写入成功`);
      const content = fs.readFileSync(configFilePath, 'utf8');
      log(`  配置内容:\n${content}`);
    } catch (e) {
      log(`  [FAIL] 写入配置: ${e.message.substring(0, 150)}`);
    }

    // [5c] 写入后尝试启用桥
    log('  [5c] 写入配置后再次 setEnabled(true)...');
    try {
      const r = await withTimeout(vscode.commands.executeCommand('icube.imBridge.setEnabled', true), 5000);
      log(`    [OK] setEnabled(true): ${JSON.stringify(r) || '(undefined)'}`);
    } catch (e) {
      log(`    [FAIL] setEnabled: ${(e.message || String(e)).substring(0, 150)}`);
    }

    // [5d] 尝试 login
    log('  [5d] 尝试 feishu.login()...');
    try {
      const r = await withTimeout(vscode.commands.executeCommand('icube.imBridge.feishu.login'), 5000);
      log(`    [OK] login: ${JSON.stringify(r)?.substring(0, 300) || '(undefined)'}`);
    } catch (e) {
      log(`    [FAIL] login: ${(e.message || String(e)).substring(0, 150)}`);
    }

    // [5e] 检查绑定状态
    log('  [5e] 检查绑定状态...');
    try {
      const r = await withTimeout(vscode.commands.executeCommand('icube.imBridge.feishu.checkBound'), 3000);
      log(`    [OK] checkBound: ${JSON.stringify(r) || '(undefined)'}`);
    } catch (e) {
      log(`    [FAIL] checkBound: ${(e.message || String(e)).substring(0, 150)}`);
    }

    // [5e2] 如果未绑定，尝试用各种参数调用 login
    log('  [5e2] 尝试带参数 login...');
    if (configFilePath) {
      try {
        const currentConfig = fs.readFileSync(configFilePath, 'utf8');
        log(`    当前配置:\n${currentConfig}`);
      } catch (e) {
        log(`    读取配置失败: ${e.message.substring(0, 80)}`);
      }
    }
    const loginTrials = [
      { label: 'login({appId, appSecret})', args: [{ appId: 'APP_ID_REDACTED', appSecret: 'APP_SECRET_REDACTED' }] },
      { label: 'login({app_id, app_secret})', args: [{ app_id: 'APP_ID_REDACTED', app_secret: 'APP_SECRET_REDACTED' }] },
      { label: 'login({appId, appSecret, brand})', args: [{ appId: 'APP_ID_REDACTED', appSecret: 'APP_SECRET_REDACTED', brand: 'feishu' }] },
      { label: 'login("APP_ID_REDACTED", "APP_SECRET_REDACTED")', args: ['APP_ID_REDACTED', 'APP_SECRET_REDACTED'] },
    ];
    for (const t of loginTrials) {
      try {
        const r = await withTimeout(vscode.commands.executeCommand('icube.imBridge.feishu.login', ...t.args), 5000);
        log(`    [OK] ${t.label}: ${JSON.stringify(r)?.substring(0, 200) || '(undefined)'}`);
      } catch (e) {
        log(`    [FAIL] ${t.label}: ${(e.message || String(e)).substring(0, 150)}`);
      }
    }

    // [5e3] 尝试写入 snake_case 格式的配置
    log('  [5e3] 尝试 snake_case 格式配置...');
    const snakeConfig = {
      app_id: 'APP_ID_REDACTED',
      app_secret: 'APP_SECRET_REDACTED',
      brand: 'feishu',
      enabled: true
    };
    try {
      fs.writeFileSync(configFilePath, JSON.stringify(snakeConfig, null, 2), 'utf8');
      log(`    [OK] snake_case 配置已写入`);
      log('    [5e3b] setEnabled(true) + login...');
      await withTimeout(vscode.commands.executeCommand('icube.imBridge.setEnabled', true), 3000);
      const r2 = await withTimeout(vscode.commands.executeCommand('icube.imBridge.feishu.login'), 5000);
      log(`    login 结果: ${JSON.stringify(r2)?.substring(0, 200) || '(undefined)'}`);
      const r3 = await withTimeout(vscode.commands.executeCommand('icube.imBridge.feishu.checkBound'), 3000);
      log(`    checkBound: ${JSON.stringify(r3) || '(undefined)'}`);
    } catch (e) {
      log(`    [FAIL] ${e.message.substring(0, 150)}`);
    }

    // [5e4] 尝试列出所有 icube.imBridge.* 命令
    log('  [5e4] 列出所有 imBridge.* 命令...');
    try {
      const allCmds = await vscode.commands.getCommands(true);
      const imBridgeCmds = allCmds.filter(c => c.startsWith('icube.imBridge.'));
      log(`    共 ${imBridgeCmds.length} 个 imBridge.* 命令:`);
      for (const c of imBridgeCmds) {
        log(`      - ${c}`);
      }
    } catch (e) {
      log(`    [FAIL] ${(e.message || String(e)).substring(0, 150)}`);
    }

    // [5e5] 尝试 feishu.connect / feishu.authorize / feishu.oauth
    log('  [5e5] 尝试其他 feishu 连接命令...');
    const altCmds = ['icube.imBridge.feishu.connect', 'icube.imBridge.feishu.authorize', 'icube.imBridge.feishu.oauth'];
    for (const cmd of altCmds) {
      try {
        const r = await withTimeout(vscode.commands.executeCommand(cmd), 3000);
        log(`    [OK] ${cmd}: ${JSON.stringify(r)?.substring(0, 200) || '(undefined)'}`);
      } catch (e) {
        log(`    [FAIL] ${cmd}: ${(e.message || String(e)).substring(0, 120)}`);
      }
    }

    // [5f] 获取事件列表
    log('  [5f] 获取事件列表...');
    try {
      const r = await withTimeout(vscode.commands.executeCommand('icube.imBridge.feishu.getEvents'), 5000);
      log(`    [OK] getEvents: ${JSON.stringify(r)?.substring(0, 500) || '(undefined)'}`);
    } catch (e) {
      log(`    [FAIL] getEvents: ${(e.message || String(e)).substring(0, 150)}`);
    }

    // [5g] 探索 sessionBind 流程
    log('  [5g] 探索 sessionBind 流程...');
    const sessionBindTrials = [
      { label: 'sessionBind.login()', args: [] },
      { label: 'sessionBind.login("")', args: [''] },
      { label: 'sessionBind.login("APP_ID_REDACTED")', args: ['APP_ID_REDACTED'] },
      { label: 'sessionBind.login("APP_ID_REDACTED", "APP_SECRET_REDACTED")', args: ['APP_ID_REDACTED', 'APP_SECRET_REDACTED'] },
      { label: 'sessionBind.confirm()', args: [] },
      { label: 'sessionBind.cancel()', args: [] },
      { label: 'getWorkspaceBot()', args: [] },
      { label: 'resolveSessionByAppId()', args: [] },
      { label: 'getBotName()', args: [] },
      { label: 'getBotAvatarUrl()', args: [] },
    ];
    for (const t of sessionBindTrials) {
      try {
        const cmdName = 'icube.imBridge.feishu.' + t.label.split('(')[0];
        const r = await withTimeout(vscode.commands.executeCommand(cmdName, ...t.args), 5000);
        log(`    [OK] ${t.label}: ${JSON.stringify(r)?.substring(0, 300) || '(undefined)'}`);
      } catch (e) {
        log(`    [FAIL] ${t.label}: ${(e.message || String(e)).substring(0, 150)}`);
      }
    }

    // [5g2] 直接调用 sessionBind.login 获取原始错误（不用 withTimeout）
    log('  [5g2] 直接调用 sessionBind.login 获取原始错误...');
    try {
      const r = await vscode.commands.executeCommand('icube.imBridge.feishu.sessionBind.login');
      log(`    [OK] sessionBind.login() 原始结果: ${JSON.stringify(r)?.substring(0, 300) || '(undefined)'}`);
    } catch (e) {
      log(`    [FAIL] sessionBind.login() 原始错误: ${(e.message || String(e)).substring(0, 200)}`);
      // 检查错误详情
      if (e && e.stack) {
        log(`    [STACK] ${e.stack.substring(0, 300)}`);
      }
    }

    // [5g3] 尝试 feishu.login 不带 timeout
    log('  [5g3] 直接调用 feishu.login 获取原始错误...');
    try {
      const r = await vscode.commands.executeCommand('icube.imBridge.feishu.login');
      log(`    [OK] feishu.login() 原始结果: ${JSON.stringify(r)?.substring(0, 300) || '(undefined)'}`);
    } catch (e) {
      log(`    [FAIL] feishu.login() 原始错误: ${(e.message || String(e)).substring(0, 200)}`);
    }

    // [5g4] 尝试 lark-cli 工具
    log('  [5g4] 探索 lark-cli 工具...');
    const larkCliPath = PATHS?.LARK_CLI || findLarkCli();
    try {
      if (larkCliPath && fs.existsSync(larkCliPath)) {
        log(`    [FOUND] lark-cli.exe 存在`);
        log(`    路径: ${larkCliPath}`);
      } else {
        log(`    [NOT FOUND] lark-cli.exe 不存在`);
      }
    } catch (e) {
      log(`    [ERROR] ${e.message.substring(0, 80)}`);
    }

    // [5g5] 尝试读取 .app.json
    log('  [5g5] 读取 .app.json...');
    try {
      const os = require('os');
      const appJsonPath = path.join(os.homedir(), '.trae-cn', 'plugins', 'trae-remote-official', 'lark', '.app.json');
      if (fs.existsSync(appJsonPath)) {
        const content = fs.readFileSync(appJsonPath, 'utf8');
        log(`    [FOUND] .app.json:\n${content.substring(0, 500)}`);
      } else {
        log(`    [NOT FOUND] .app.json 不存在`);
      }
    } catch (e) {
      log(`    [ERROR] ${e.message.substring(0, 80)}`);
    }

    // [5h] 探索 IM_BRIDGE_CONFIG 环境变量
    log('  [5h] 探索 IM_BRIDGE_CONFIG 环境变量...');
    const os = require('os');
    const homeDir = os.homedir();
    const envPaths = [
      path.join(homeDir, '.trae-cn', 'im_bridge_config.json'),
      path.join(homeDir, '.trae-cn', 'im_bridge_config.json'),
      path.join(homeDir, '.trae-cn', 'plugins', 'trae-remote-official', 'im_bridge_config.json'),
    ];
    for (const p of envPaths) {
      try {
        if (fs.existsSync(p)) {
          const content = fs.readFileSync(p, 'utf8');
          log(`    [FOUND] ${p}:\n${content.substring(0, 300)}`);
        } else {
          log(`    [NOT FOUND] ${p}`);
        }
      } catch (e) {
        log(`    [ERROR] ${p}: ${e.message.substring(0, 80)}`);
      }
    }
    // 搜索包含 IM_BRIDGE 的文件
    log('  [5h2] 搜索 .trae-cn 下的 im_bridge 相关文件...');
    try {
      const baseDir = path.join(homeDir, '.trae-cn');
      const files = fs.readdirSync(baseDir);
      for (const f of files) {
        if (f.toLowerCase().includes('bridge') || f.toLowerCase().includes('im_bridge')) {
          log(`    [FOUND] ${f}`);
        }
      }
      // 搜索 plugins 目录
      const pluginsDir = path.join(baseDir, 'plugins');
      if (fs.existsSync(pluginsDir)) {
        const plugins = fs.readdirSync(pluginsDir);
        for (const p of plugins) {
          log(`    插件: ${p}`);
          const pluginPath = path.join(pluginsDir, p);
          try {
            const subFiles = fs.readdirSync(pluginPath, { recursive: true });
            for (const sf of subFiles) {
              if (typeof sf === 'string' && (sf.includes('bridge') || sf.includes('im_bridge') || sf.includes('config'))) {
                log(`      [MATCH] ${sf}`);
              }
            }
          } catch (e) {}
        }
      }
    } catch (e) {
      log(`    [ERROR] 搜索失败: ${e.message.substring(0, 100)}`);
    }
  } else {
    log('--- [5b] 跳过: configFilePath 为 null ---');
  }
  log('');

  // [6] 再次检查绑定状态
  log('--- [6] checkBound (绑定状态) ---');
  try {
    const r = await withTimeout(vscode.commands.executeCommand('icube.imBridge.feishu.checkBound'), 3000);
    log(`  [OK] checkBound: ${JSON.stringify(r) || '(undefined)'}`);
  } catch (e) {
    log(`  [FAIL] checkBound: ${e.message.substring(0, 120)}`);
  }
  log('');

  // [7] getProductDataFolderPath（查找 Trae 数据目录，可能含配置）
  log('--- [7] getProductDataFolderPath ---');
  try {
    const r = await withTimeout(vscode.commands.executeCommand('icube.common.commands.getProductDataFolderPath'), 3000);
    log(`  [OK] ${JSON.stringify(r) || '(undefined)'}`);
  } catch (e) {
    log(`  [FAIL] ${e.message.substring(0, 120)}`);
  }
  log('');

  log('=== 飞书桥探测完成 ===');
  outputChannel.show(true);
  vscode.window.showInformationMessage('XiaoT1 Bridge: 飞书桥探测完成，查看 Output');
}

// ========== 完整飞书桥接链路 ==========

async function startFullBridge() {
  log('=== 启动完整飞书桥接 ===');

  // 确保 session 状态已从文件恢复（覆盖 activate 之后可能的变更）
  loadSessionState();

  if (isBridgeRunning) {
    log('桥接已在运行，先停止...');
    stopFullBridge();
    await sleep(1000);
  }

  // 创建 replies 目录
  if (!fs.existsSync(PATHS.REPLIES_DIR)) {
    fs.mkdirSync(PATHS.REPLIES_DIR, { recursive: true });
    log(`创建 replies 目录: ${PATHS.REPLIES_DIR}`);
  }

  // 清理旧的 sideband 文件
  try {
    const oldFiles = fs.readdirSync(PATHS.REPLIES_DIR);
    for (const f of oldFiles) {
      fs.unlinkSync(path.join(PATHS.REPLIES_DIR, f));
    }
    log(`清理 ${oldFiles.length} 个旧 sideband 文件`);
  } catch (e) { /* 忽略 */ }

  // 启动 fs.watch 目录监听（零延迟检测 sideband 文件）
  setupReplyWatcher();

  // 启动 lark-cli event consume
  const args = [
    '--profile', PATHS.LARK_PROFILE,
    'event', 'consume', 'im.message.receive_v1',
    '--as', 'bot',
    '--timeout', PATHS.BRIDGE_TIMEOUT
  ];

  log(`启动 lark-cli: ${PATHS.LARK_CLI} ${args.join(' ')}`);
  bridgeProcess = spawn(PATHS.LARK_CLI, args, {
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true
  });
  isBridgeRunning = true;

  log(`lark-cli event consume 已启动 (PID: ${bridgeProcess.pid})`);
  log('等待飞书消息...');
  log('发送 "XiaoT1 Bridge: Stop Full Bridge" 命令停止');
  log('');

  // 监听 stdout（事件 JSON）
  let stdoutBuffer = '';
  let eventCount = 0;
  bridgeProcess.stdout.on('data', (data) => {
    stdoutBuffer += data.toString();
    let lines = stdoutBuffer.split('\n');
    stdoutBuffer = lines.pop();  // 保留最后一行（可能不完整）
    for (const line of lines) {
      const trimmed = line.trim();
      if (trimmed.startsWith('{')) {
        try {
          const event = JSON.parse(trimmed);
          eventCount++;
          const eventId = event.event_id?.substring(0, 16) || 'unknown';
          const msgType = event.message_type || 'unknown';
          const content = event.content?.substring(0, 50) || '';
          log(`[lark-cli] [事件#${eventCount}] 收到事件: eventId=${eventId}..., type=${msgType}, content="${content}"`);
          enqueueEvent(event);
        } catch (e) {
          // 非 JSON，忽略
          log(`[lark-cli] 解析 stdout JSON 失败: ${e.message?.substring(0, 80)}, line="${trimmed?.substring(0, 80)}"`);
        }
      }
    }
  });

  bridgeProcess.stderr.on('data', (data) => {
    const msg = data.toString().trim();
    if (msg) log(`[lark-cli] ${msg}`);
  });

  bridgeProcess.on('exit', (code, signal) => {
    log(`lark-cli event consume 已退出 (code: ${code}, signal: ${signal})`);
    isBridgeRunning = false;
    bridgeProcess = null;
  });

  // 启动队列处理器
  processQueue();

  outputChannel.show(true);
  vscode.window.showInformationMessage('XiaoT1 Bridge: 完整桥接已启动，等待飞书消息');
}

function stopFullBridge() {
  cleanupReplyWatcher();
  if (bridgeProcess) {
    log('停止 lark-cli event consume...');
    try {
      bridgeProcess.kill();
    } catch (e) { /* 忽略 */ }
    bridgeProcess = null;
    isBridgeRunning = false;
    log('桥接已停止');
    vscode.window.showInformationMessage('XiaoT1 Bridge: 桥接已停止');
  } else {
    log('桥接未运行');
  }
  messageQueue = [];
  isProcessing = false;
}

function setupReplyWatcher() {
  if (replyWatcher) return;
  try {
    replyWatcher = fs.watch(PATHS.REPLIES_DIR, { persistent: false }, (eventType, filename) => {
      if (!filename) return;
      if (filename.endsWith('.txt')) {
        log(`[fs.watch] 检测到文件事件: type=${eventType}, filename=${filename}`);
        watchDetectedFiles.add(filename);
      }
    });
    log(`[fs.watch] replies 目录监听器已启动 (dir=${PATHS.REPLIES_DIR})`);
  } catch (e) {
    log(`[fs.watch] 启动失败: ${e.message}`);
  }
}

function cleanupReplyWatcher() {
  if (replyWatcher) {
    try { replyWatcher.close(); } catch (e) { /* 忽略 */ }
    replyWatcher = null;
    watchDetectedFiles.clear();
    log('[fs.watch] 目录监听器已关闭');
  }
}

function enqueueEvent(event) {
  const eventId = event.event_id;
  const messageId = event.message_id;
  const content = event.content;
  const senderId = event.sender_id;

  const now = Date.now();
  timingMap.set(messageId, { t0: now, eventId });
  log(`[enqueueEvent] [PERF] T0 事件接收: ${now}ms, messageId=${messageId?.substring(0, 16)}..., eventId=${eventId?.substring(0, 16)}..., 内容长度=${content?.length || 0}`);
  log(`[enqueueEvent] 开始处理事件: eventId=${eventId?.substring(0, 16)}..., messageId=${messageId?.substring(0, 16)}..., content="${content?.substring(0, 50)}"`);

  // 去重
  if (processedEventIds.has(eventId)) {
    log(`[enqueueEvent] [SKIP] 重复事件，已处理过: ${eventId?.substring(0, 16)}...`);
    return;
  }
  processedEventIds.add(eventId);
  log(`[enqueueEvent] 事件去重检查通过，已加入处理集合 (集合大小: ${processedEventIds.size})`);

  // 限制去重集合大小
  if (processedEventIds.size > 100) {
    const arr = Array.from(processedEventIds);
    processedEventIds = new Set(arr.slice(-50));
    log(`[enqueueEvent] 去重集合已裁剪: ${arr.length} → ${processedEventIds.size}`);
  }

  // 清理超过 5 分钟的 timingMap 旧条目
  if (timingMap.size > 20) {
    const now = Date.now();
    let cleaned = 0;
    for (const [key, val] of timingMap) {
      if (val.t0 && now - val.t0 > 300000) {
        timingMap.delete(key);
        cleaned++;
      }
    }
    if (cleaned > 0) log(`[enqueueEvent] timingMap 清理: 删除 ${cleaned} 条过期条目, 剩余 ${timingMap.size} 条`);
  }

  log(`[收到] 飞书消息: "${content}" (event: ${eventId?.substring(0, 8)}..., from: ${senderId?.substring(0, 10)}...)`);
  messageQueue.push(event);
  log(`[队列] 事件已入队，当前 ${messageQueue.length} 条待处理 (eventId=${eventId?.substring(0, 16)}...)`);
  processQueue();
}

async function processQueue() {
  if (isProcessing) {
    log(`[processQueue] 已有任务在处理中，跳过 (队列剩余: ${messageQueue.length})`);
    return;
  }
  isProcessing = true;
  log(`[processQueue] 开始处理队列，共 ${messageQueue.length} 条待处理`);

  let processedCount = 0;
  let errorCount = 0;

  while (messageQueue.length > 0) {
    const event = messageQueue.shift();
    processedCount++;
    const eventId = event?.event_id?.substring(0, 16) || 'unknown';
    const messageId = event?.message_id?.substring(0, 16) || 'unknown';
    log(`[processQueue] [${processedCount}] 处理事件: eventId=${eventId}..., messageId=${messageId}..., 队列剩余: ${messageQueue.length}`);

    try {
      await handleFeishuEvent(event);
      log(`[processQueue] [${processedCount}] ✅ 事件处理完成: eventId=${eventId}...`);
    } catch (e) {
      errorCount++;
      log(`[processQueue] [${processedCount}] ❌ 事件处理失败: eventId=${eventId}..., error=${e.message?.substring(0, 100)}`);
      if (event?.message_id) {
        try {
          const errMsg = `处理失败: ${e.message?.substring(0, 100) || '未知错误'}`;
          log(`[processQueue] [${processedCount}] 发送错误回复到飞书: ${errMsg}`);
          await sendFeishuReply(errMsg);
        } catch (sendErr) {
          log(`[processQueue] [${processedCount}] ❌ 错误回复发送也失败: ${sendErr.message?.substring(0, 80)}`);
        }
      }
    }
  }

  log(`[processQueue] 队列处理完成: 处理 ${processedCount} 条, 成功 ${processedCount - errorCount}, 失败 ${errorCount}`);
  isProcessing = false;
}

// ========== Session 状态持久化（文件存储，重启恢复） ==========

function loadSessionState() {
  log(`[Session] [load] 开始从文件加载 session 状态: ${PATHS.SESSION_STATE_FILE}`);
  try {
    const fileExists = fs.existsSync(PATHS.SESSION_STATE_FILE);
    log(`[Session] [load] 文件存在: ${fileExists}`);

    if (!fileExists) {
      log(`[Session] [load] session_state.json 不存在，跳过加载 (首次启动或已被清理)`);
      return false;
    }

    const rawContent = fs.readFileSync(PATHS.SESSION_STATE_FILE, 'utf8');
    log(`[Session] [load] 文件原始内容 (${rawContent.length} 字符): ${rawContent.substring(0, 200)}`);

    const data = JSON.parse(rawContent);
    log(`[Session] [load] JSON 解析成功, 顶层键: ${Object.keys(data).join(', ')}`);

    if (!data || !data.feishuSessionId) {
      log(`[Session] [load] ⚠️ 无效数据: feishuSessionId 缺失 (data=${JSON.stringify(data).substring(0, 100)})`);
      return false;
    }

    const savedId = data.feishuSessionId;
    const savedLastUsed = data.feishuSessionLastUsed || 0;
    const savedAt = data.savedAt || 0;

    log(`[Session] [load] 解析结果: sessionId=${savedId.substring(0, 12)}..., lastUsed=${savedLastUsed} (${savedLastUsed ? new Date(savedLastUsed).toISOString() : '无'}), savedAt=${savedAt ? new Date(savedAt).toISOString() : '无'}`);

    feishuSessionId = savedId;
    feishuSessionLastUsed = savedLastUsed;
    log(`[Session] [load] ✅ 内存变量已更新: feishuSessionId=${feishuSessionId.substring(0, 12)}..., feishuSessionLastUsed=${feishuSessionLastUsed}`);

    // 检查是否超时
    if (feishuSessionLastUsed) {
      const elapsed = Date.now() - feishuSessionLastUsed;
      const timeoutMin = SESSION_RESET_TIMEOUT / 60000;
      log(`[Session] [load] 超时检查: 已过 ${Math.round(elapsed / 60000)} 分钟, 阈值 ${timeoutMin} 分钟`);

      if (elapsed > SESSION_RESET_TIMEOUT) {
        log(`[Session] [load] ⚠️ session 已超时 (${Math.round(elapsed / 60000)} 分钟 > ${timeoutMin} 分钟), 自动清除`);
        feishuSessionId = null;
        feishuSessionLastUsed = 0;
        clearSessionState();
        return false;
      } else {
        log(`[Session] [load] ✅ session 未超时，恢复成功`);
      }
    } else {
      log(`[Session] [load] ⚠️ lastUsed 为 0，无法判断超时，视为有效 session`);
    }

    return true;
  } catch (e) {
    log(`[Session] [load] ❌ 加载失败: ${e.message}`);
    log(`[Session] [load] 错误堆栈: ${e.stack?.substring(0, 300) || '无'}`);
    return false;
  }
}

function saveSessionState() {
  log(`[Session] [save] 开始持久化 session 状态`);
  log(`[Session] [save] 内存状态: feishuSessionId=${feishuSessionId ? feishuSessionId.substring(0, 12) + '...' : 'null'}, feishuSessionLastUsed=${feishuSessionLastUsed} (${feishuSessionLastUsed ? new Date(feishuSessionLastUsed).toISOString() : '无'})`);

  try {
    if (!feishuSessionId) {
      log(`[Session] [save] ⚠️ feishuSessionId 为 null，跳过保存`);
      return;
    }

    const data = {
      feishuSessionId: feishuSessionId,
      feishuSessionLastUsed: feishuSessionLastUsed,
      savedAt: Date.now()
    };

    const jsonStr = JSON.stringify(data, null, 2);
    log(`[Session] [save] 准备写入 JSON (${jsonStr.length} 字符): ${jsonStr.substring(0, 200)}`);

    const dir = path.dirname(PATHS.SESSION_STATE_FILE);
    if (!fs.existsSync(dir)) {
      log(`[Session] [save] 目录不存在，创建: ${dir}`);
      fs.mkdirSync(dir, { recursive: true });
    }

    fs.writeFileSync(PATHS.SESSION_STATE_FILE, jsonStr);
    log(`[Session] [save] ✅ 写入成功: ${PATHS.SESSION_STATE_FILE}`);

    // 验证写入
    const verify = fs.readFileSync(PATHS.SESSION_STATE_FILE, 'utf8');
    log(`[Session] [save] 验证: 读回 ${verify.length} 字符, 与写入一致=${verify === jsonStr}`);
  } catch (e) {
    log(`[Session] [save] ❌ 保存失败: ${e.message}`);
    log(`[Session] [save] 错误堆栈: ${e.stack?.substring(0, 300) || '无'}`);
  }
}

function clearSessionState() {
  log(`[Session] [clear] 开始清除 session_state.json`);
  try {
    if (fs.existsSync(PATHS.SESSION_STATE_FILE)) {
      fs.unlinkSync(PATHS.SESSION_STATE_FILE);
      log(`[Session] [clear] ✅ 文件已删除: ${PATHS.SESSION_STATE_FILE}`);
    } else {
      log(`[Session] [clear] 文件不存在，无需清除`);
    }
  } catch (e) {
    log(`[Session] [clear] ❌ 清除失败: ${e.message}`);
  }
}

// ========== 飞书 Session 管理函数 ==========

function resetFeishuSession(reason) {
  const oldId = feishuSessionId;
  feishuSessionId = null;
  feishuSessionLastUsed = 0;
  clearSessionState();
  log(`[Session] 重置飞书 session (原因: ${reason || '未说明'})${oldId ? ', 旧 session: ' + oldId.substring(0, 12) + '...' : ''}`);
}

async function trySendToAgent(message, sidebandFile) {
  // 1. 检查是否为 session 重置指令
  const strippedMsg = message.trim();
  if (SESSION_RESET_COMMANDS.some(cmd => strippedMsg === cmd)) {
    resetFeishuSession('用户指令');
    return { resetCommand: true, replyText: '已重置对话，新消息将创建新 session' };
  }

  // 2. 检查 session 超时
  if (feishuSessionId && Date.now() - feishuSessionLastUsed > SESSION_RESET_TIMEOUT) {
    resetFeishuSession('超时 (30分钟无消息)');
  }

  // 3. 尝试复用已有 session（多种策略）
  let sendResult = null;
  
  // 策略 A: 直接传递 sessionId 参数
  if (feishuSessionId) {
    log(`[Session] 尝试复用 session: ${feishuSessionId.substring(0, 12)}...`);
    const sessionAttempts = [
      { sessionId: feishuSessionId },
      { session_id: feishuSessionId },
      { targetSessionId: feishuSessionId },
    ];
    for (const opts of sessionAttempts) {
      try {
        const r = await vscode.commands.executeCommand(
          'icube.chat.sendToAgentNonBlocking',
          [message],
          { enableUnstableFields: true, ...opts }
        );
        log(`[Session] 尝试 ${Object.keys(opts)[0]} 参数, 返回 sessionId: ${r?.sessionId?.substring(0, 12) || '无'}`);
        if (r && r.sessionId) {
          sendResult = r;
          // 检查是否复用成功（返回的 sessionId 与传入的相同）
          if (r.sessionId === feishuSessionId) {
            log(`[Session] ✅ 复用成功`);
            break;  // 复用成功，不再尝试其他格式
          } else {
            log(`[Session] ⚠️ 返回了新 session (${r.sessionId?.substring(0, 12)}...), 尝试下一种格式`);
            // 继续尝试其他格式
            sendResult = null;
          }
        }
      } catch (e) {
        log(`[Session] 参数 ${Object.keys(opts)[0]} 失败: ${e.message?.substring(0, 50)}`);
      }
    }
  }

  // 策略 B: 如果策略 A 失败，尝试获取当前 chat 面板会话
  if (!sendResult) {
    try {
      const currentSession = await vscode.commands.executeCommand('icube.chat.getCurrentSessionId');
      log(`[Session] 当前 chat session: ${currentSession || '(无)'}`);

      // 策略 D: feishuSessionId 为 null 时，复用当前 chat 面板会话
      if (!feishuSessionId && currentSession) {
        log(`[Session] 无保存 session，尝试复用当前 chat 会话: ${currentSession.substring(0, 12)}...`);
        const reuseAttempts = [
          { sessionId: currentSession },
          { session_id: currentSession },
          { targetSessionId: currentSession },
        ];
        for (const opts of reuseAttempts) {
          try {
            const r = await vscode.commands.executeCommand(
              'icube.chat.sendToAgentNonBlocking',
              [message],
              { enableUnstableFields: true, ...opts }
            );
            log(`[Session] 尝试 ${Object.keys(opts)[0]} 参数, 返回 sessionId: ${r?.sessionId?.substring(0, 12) || '无'}`);
            if (r && r.sessionId === currentSession) {
              log(`[Session] ✅ 复用当前 chat 会话成功`);
              sendResult = r;
              break;
            } else if (r && r.sessionId) {
              log(`[Session] ⚠️ 返回了新 session (${r.sessionId?.substring(0, 12)}...), 尝试下一种格式`);
              sendResult = null;
            }
          } catch (e) {
            log(`[Session] 参数 ${Object.keys(opts)[0]} 失败: ${e.message?.substring(0, 50)}`);
          }
        }
      } else if (currentSession && currentSession === feishuSessionId) {
        // 当前 session 与保存的相同，直接发送
        log(`[Session] 当前 session 匹配，直接发送到活跃会话`);
        sendResult = await vscode.commands.executeCommand(
          'icube.chat.sendToAgentNonBlocking',
          [message],
          { enableUnstableFields: true }
        );
        log(`[Session] 发送完成, sessionId: ${sendResult?.sessionId?.substring(0, 12) || '无'}`);
      }
    } catch (e) {
      log(`[Session] 获取当前 session 失败: ${e.message?.substring(0, 50)}`);
    }
  }

  // 4. 所有复用策略都失败 → 创建新 session
  if (!sendResult) {
    if (feishuSessionId) {
      log('[Session] ❌ 所有复用策略都失败，创建新 session');
    } else {
      log('[Session] 首次消息，创建新 session');
    }
    try {
      sendResult = await vscode.commands.executeCommand(
        'icube.chat.sendToAgentNonBlocking',
        [message],
        { enableUnstableFields: true, newSession: true }
      );
      log(`[Session] 新 session 创建成功: ${sendResult?.sessionId?.substring(0, 12) || '无'}`);
    } catch (e) {
      throw e;
    }
  }

  // 5. 更新 session 状态
  if (sendResult?.sessionId) {
    if (sendResult.sessionId !== feishuSessionId) {
      log(`[Session] 保存 session: ${sendResult.sessionId.substring(0, 12)}...`);
    }
    feishuSessionId = sendResult.sessionId;
    feishuSessionLastUsed = Date.now();
    saveSessionState();
  }

  return { sendResult };
}

async function handleFeishuEvent(event) {
  const content = event.content || '';
  const messageId = event.message_id || '';
  const senderId = event.sender_id || '';
  const chatType = event.chat_type || 'p2p';
  const eventId = event.event_id || '';

  const t1 = Date.now();
  if (timingMap.has(messageId)) {
    const existing = timingMap.get(messageId);
    timingMap.set(messageId, { ...existing, t1 });
  }
  log(`[handleFeishuEvent] [PERF] T1 开始处理: ${t1}ms, 距T0=${t1 - (timingMap.get(messageId)?.t0 || t1)}ms, messageId=${messageId?.substring(0, 16)}...`);
  log(`[handleFeishuEvent] 开始处理: messageId=${messageId?.substring(0, 16)}..., chatType=${chatType}, messageType=${event.message_type || 'text'}, content="${content?.substring(0, 50)}"`);

  // 只处理文本消息
  if (event.message_type && event.message_type !== 'text') {
    log(`[handleFeishuEvent] [SKIP] 非文本消息: ${event.message_type}, messageId=${messageId?.substring(0, 16)}..., 已回复不支持提示`);
    timingMap.delete(messageId);
    await sendFeishuReply(`暂不支持 ${event.message_type} 类型消息`);
    return;
  }

  // sideband 文件路径
  const sidebandFile = path.join(PATHS.REPLIES_DIR, `${messageId}.txt`);
  log(`[handleFeishuEvent] sideband 文件路径: ${sidebandFile}`);

  // 清理 watchDetectedFiles 中的残留条目（只保留当前消息的）
  const expectedBase = `${messageId}.txt`;
  if (watchDetectedFiles.size > 0) {
    const beforeSize = watchDetectedFiles.size;
    for (const f of watchDetectedFiles) {
      if (f !== expectedBase) watchDetectedFiles.delete(f);
    }
    const afterSize = watchDetectedFiles.size;
    log(`[handleFeishuEvent] watchDetectedFiles 清理: ${beforeSize} → ${afterSize} (保留当前消息的条目)`);
  }

  // 如果存在遗留文件（上次超时未清理），先删除
  if (fs.existsSync(sidebandFile)) {
    log(`[handleFeishuEvent] 发现遗留 sideband 文件，删除中... (messageId=${messageId?.substring(0, 16)}...)`);
    try { fs.unlinkSync(sidebandFile); log(`[handleFeishuEvent] ✅ 遗留文件已删除`); } catch (e) { log(`[handleFeishuEvent] ⚠️ 删除遗留文件失败: ${e.message?.substring(0, 80)}`); }
  }

  // 1. 发送消息到 Trae Agent（附 sideband 指令 + 持久 session 复用）
  const agentMessage = `[飞书消息] 用户说：${content}\n\n[系统指令] 请将回复内容写入文件：${sidebandFile}`;
  log(`[handleFeishuEvent] 准备发送到 Agent: messageId=${messageId?.substring(0, 16)}..., 当前 feishuSessionId=${feishuSessionId ? feishuSessionId.substring(0, 12) + '...' : 'null'}`);

  let sendResult = null;
  const t0 = timingMap.get(messageId)?.t0 || Date.now();
  const t2 = Date.now();
  timingMap.set(messageId, { ...timingMap.get(messageId), t0, t2 });
  try {
    log(`[handleFeishuEvent] [PERF] T2 开始发送Agent: ${t2}ms, 距T0=${t2 - t0}ms, messageId=${messageId?.substring(0, 16)}...`);
    const result = await trySendToAgent(agentMessage, sidebandFile);
    const t3 = Date.now();
    timingMap.set(messageId, { ...timingMap.get(messageId), t3 });
    log(`[handleFeishuEvent] [PERF] T3 Agent发送完成: ${t3}ms, 发送耗时=${t3 - t2}ms, 距T0=${t3 - t0}ms`);

    // 处理 session 重置指令
    if (result.resetCommand) {
      log(`[handleFeishuEvent] 用户触发重置指令，回复: ${result.replyText?.substring(0, 50)}`);
      timingMap.delete(messageId);
      await sendFeishuReply(result.replyText);
      return;
    }

    sendResult = result.sendResult;
    const sessionId = sendResult?.sessionId;
    log(`[handleFeishuEvent] ✅ Agent 发送成功, sessionId: ${sessionId?.substring(0, 12) || '(无)'}, messageId=${messageId?.substring(0, 16)}...`);
  } catch (e) {
    log(`[handleFeishuEvent] ❌ Agent 发送失败: ${e.message?.substring(0, 100)}, messageId=${messageId?.substring(0, 16)}...`);
    log(`[handleFeishuEvent] ❌ 错误堆栈: ${e.stack?.substring(0, 200) || '无'}`);

    // 如果 session 复用失败，尝试重置 session 后重试
    if (feishuSessionId) {
      log(`[handleFeishuEvent] 检测到有保存的 session (${feishuSessionId?.substring(0, 12)}...), 重置后重试...`);
      resetFeishuSession('复用失败');
      try {
        const retryResult = await vscode.commands.executeCommand(
          'icube.chat.sendToAgentNonBlocking',
          [agentMessage],
          { enableUnstableFields: true, newSession: true }
        );
        feishuSessionId = retryResult?.sessionId || null;
        feishuSessionLastUsed = Date.now();
        saveSessionState();
        log(`[handleFeishuEvent] ✅ 重试成功, 新 sessionId: ${retryResult?.sessionId?.substring(0, 12) || '(无)'}, messageId=${messageId?.substring(0, 16)}...`);
        sendResult = retryResult;
      } catch (e2) {
        log(`[handleFeishuEvent] ❌ 重试也失败: ${e2.message?.substring(0, 100)}, messageId=${messageId?.substring(0, 16)}...`);
        log(`[handleFeishuEvent] ❌ 错误回复发送到飞书`);
        timingMap.delete(messageId);
        await sendFeishuReply(`Agent 发送失败: ${e2.message?.substring(0, 80) || '未知错误'}`);
        return;
      }
    } else {
      log(`[handleFeishuEvent] 无保存的 session，直接发送错误回复`);
      timingMap.delete(messageId);
      await sendFeishuReply(`Agent 发送失败: ${e.message?.substring(0, 80) || '未知错误'}`);
      return;
    }
  }

  // 2. fs.watch + 自适应轮询：零延迟检测 sideband 文件
  const t4 = Date.now();
  timingMap.set(messageId, { ...timingMap.get(messageId), t4 });
  const perfT0 = t0;
  log(`[handleFeishuEvent] [PERF] T4 开始等待Agent回复: ${t4}ms, 距T0=${t4 - perfT0}ms, messageId=${messageId?.substring(0, 16)}...`);
  log(`[handleFeishuEvent] 开始等待 Agent 回复 (sideband=${sidebandFile}, 最大等待=600s, messageId=${messageId?.substring(0, 16)}...)`);
  const maxWait = 600000;
  const startTime = Date.now();
  let status = null;
  let lastStatus = null;
  let pollCount = 0;
  let watchHitCount = 0;

  // 辅助：尝试读取 sideband 文件（含完整性校验）
  // 关键策略：连续读取两次 + 间隔 50ms + 长度一致 = 文件写入完成
  // 防止 Agent 正在写入时读到半截内容
  async function tryReadSideband() {
    if (!fs.existsSync(sidebandFile)) return null;
    try {
      const firstRead = fs.readFileSync(sidebandFile, 'utf8').trim();
      if (!firstRead) return null;
      // 等 50ms 让文件系统 flush，再读一次比较长度
      await sleep(50);
      if (!fs.existsSync(sidebandFile)) return null;
      const secondRead = fs.readFileSync(sidebandFile, 'utf8').trim();
      if (secondRead && secondRead.length === firstRead.length) {
        return secondRead;  // 长度一致 → 写入完成
      }
      // 长度不一致 → Agent 仍在写入，下一轮再说
      log(`[handleFeishuEvent] sideband 文件仍在写入中: 首次${firstRead.length}字节, 二次${secondRead.length}字节, 等待下一轮`);
      return null;
    } catch (e) {
      return null;
    }
  }

  // 立即首次检查（此时 Agent 已完成，文件应为最终状态，直接读取）
  log(`[handleFeishuEvent] 立即首次检查 sideband 文件...`);
  if (fs.existsSync(sidebandFile)) {
    try {
      const content = fs.readFileSync(sidebandFile, 'utf8').trim();
      if (content) {
        const t5 = Date.now();
        timingMap.set(messageId, { ...timingMap.get(messageId), t5 });
        log(`[handleFeishuEvent] ✅ 立即检查命中: Agent 回复已就绪 (${content.length} 字符, ${Math.floor((Date.now() - startTime) / 1000)}s): ${content.substring(0, 80)}...`);
        fs.unlinkSync(sidebandFile);
        log(`[handleFeishuEvent] 已删除 sideband 文件，发送回复到飞书`);
        const t6 = Date.now();
        sendFeishuReply(content).then(() => {
          const t7 = Date.now();
          timingMap.set(messageId, { ...timingMap.get(messageId), t6, t7 });
          const p = timingMap.get(messageId) || {};
          log(`[PERF-END] ╔══════════════════════════════════════════════════════╗`);
          log(`[PERF-END] ║ 飞书消息处理完成 (立即路径)`);
          log(`[PERF-END] ║ messageId: ${messageId?.substring(0, 16)}...`);
          log(`[PERF-END] ║ T0→T1 入队→处理: ${(p.t1||0) - (p.t0||0)}ms`);
          log(`[PERF-END] ║ T1→T2 处理→发送: ${(p.t2||0) - (p.t1||0)}ms`);
          log(`[PERF-END] ║ T2→T3 发送→完成: ${(p.t3||0) - (p.t2||0)}ms`);
          log(`[PERF-END] ║ T3→T4 完成→等待: ${(p.t4||0) - (p.t3||0)}ms`);
          log(`[PERF-END] ║ T4→T5 等待→文件: ${(p.t5||0) - (p.t4||0)}ms`);
          log(`[PERF-END] ║ T5→T7 文件→飞书: ${(p.t7||0) - (p.t5||0)}ms`);
          log(`[PERF-END] ║ TOTAL T0→T7: ${(p.t7||0) - (p.t0||0)}ms`);
          log(`[PERF-END] ╚══════════════════════════════════════════════════════╝`);
          timingMap.delete(messageId);
        });
        return;
      }
    } catch (e) {
      log(`[handleFeishuEvent] ⚠️ 立即检查读取异常: ${e.message?.substring(0, 80)}`);
    }
  } else {
    log(`[handleFeishuEvent] 立即检查: sideband 文件尚未生成，进入轮询等待`);
  }

  while (Date.now() - startTime < maxWait) {
    const elapsed = Date.now() - startTime;
    let replyContent = null;

    // fs.watch 零延迟检测：如果 watcher 检测到该文件名
    const baseName = path.basename(sidebandFile);
    if (watchDetectedFiles.has(baseName)) {
      watchHitCount++;
      watchDetectedFiles.delete(baseName);
      log(`[handleFeishuEvent] [轮询#${++pollCount}] fs.watch 检测到 sideband 文件 (第${watchHitCount}次命中, elapsed=${Math.floor(elapsed / 1000)}s)`);
      // tryReadSideband 内置双重读取校验（50ms 间隔 + 长度一致性）
      replyContent = await tryReadSideband();
      if (replyContent) {
        const t5 = Date.now();
        timingMap.set(messageId, { ...timingMap.get(messageId), t5 });
        log(`[handleFeishuEvent] ✅ fs.watch 路径: 收到 Agent 回复 (${replyContent.length} 字符, ${Math.floor(elapsed / 1000)}s): ${replyContent.substring(0, 80)}...`);
        fs.unlinkSync(sidebandFile);
        log(`[handleFeishuEvent] 已删除 sideband 文件，发送回复到飞书 (fs.watch 路径)`);
        const t6 = Date.now();
        sendFeishuReply(replyContent).then(() => {
          const t7 = Date.now();
          timingMap.set(messageId, { ...timingMap.get(messageId), t6, t7 });
          const p = timingMap.get(messageId) || {};
          log(`[PERF-END] ╔══════════════════════════════════════════════════════╗`);
          log(`[PERF-END] ║ 飞书消息处理完成 (fs.watch 路径)`);
          log(`[PERF-END] ║ messageId: ${messageId?.substring(0, 16)}...`);
          log(`[PERF-END] ║ T0→T1 入队→处理: ${(p.t1||0) - (p.t0||0)}ms`);
          log(`[PERF-END] ║ T1→T2 处理→发送: ${(p.t2||0) - (p.t1||0)}ms`);
          log(`[PERF-END] ║ T2→T3 发送→完成: ${(p.t3||0) - (p.t2||0)}ms`);
          log(`[PERF-END] ║ T3→T4 完成→等待: ${(p.t4||0) - (p.t3||0)}ms`);
          log(`[PERF-END] ║ T4→T5 等待→文件: ${(p.t5||0) - (p.t4||0)}ms`);
          log(`[PERF-END] ║ T5→T7 文件→飞书: ${(p.t7||0) - (p.t5||0)}ms`);
          log(`[PERF-END] ║ TOTAL T0→T7: ${(p.t7||0) - (p.t0||0)}ms`);
          log(`[PERF-END] ╚══════════════════════════════════════════════════════╝`);
          timingMap.delete(messageId);
        });
        return;
      } else {
        log(`[handleFeishuEvent] [轮询#${pollCount}] fs.watch 命中但文件校验未通过 (仍在写入或读取为空), 继续等待`);
      }
    }

    // 自适应间隔：前30秒500ms，之后200ms，状态完成后100ms
    let interval = elapsed < 30000 ? 500 : 200;
    if (status === 'WaitingInput' || status === 'Idle') {
      interval = 100;
    }
    await sleep(interval);

    // 轮询 fallback：tryReadSideband 含双重读取校验
    replyContent = await tryReadSideband();
    if (replyContent) {
      const t5 = Date.now();
      timingMap.set(messageId, { ...timingMap.get(messageId), t5 });
      log(`[handleFeishuEvent] ✅ 轮询路径: 收到 Agent 回复 (${replyContent.length} 字符, ${Math.floor(elapsed / 1000)}s, poll#${pollCount}): ${replyContent.substring(0, 80)}...`);
      fs.unlinkSync(sidebandFile);
      log(`[handleFeishuEvent] 已删除 sideband 文件，发送回复到飞书 (轮询路径)`);
      const t6 = Date.now();
      sendFeishuReply(replyContent).then(() => {
        const t7 = Date.now();
        timingMap.set(messageId, { ...timingMap.get(messageId), t6, t7 });
        const p = timingMap.get(messageId) || {};
        log(`[PERF-END] ╔══════════════════════════════════════════════════════╗`);
        log(`[PERF-END] ║ 飞书消息处理完成 (轮询路径)`);
        log(`[PERF-END] ║ messageId: ${messageId?.substring(0, 16)}...`);
        log(`[PERF-END] ║ T0→T1 入队→处理: ${(p.t1||0) - (p.t0||0)}ms`);
        log(`[PERF-END] ║ T1→T2 处理→发送: ${(p.t2||0) - (p.t1||0)}ms`);
        log(`[PERF-END] ║ T2→T3 发送→完成: ${(p.t3||0) - (p.t2||0)}ms`);
        log(`[PERF-END] ║ T3→T4 完成→等待: ${(p.t4||0) - (p.t3||0)}ms`);
        log(`[PERF-END] ║ T4→T5 等待→文件: ${(p.t5||0) - (p.t4||0)}ms`);
        log(`[PERF-END] ║ T5→T7 文件→飞书: ${(p.t7||0) - (p.t5||0)}ms`);
        log(`[PERF-END] ║ TOTAL T0→T7: ${(p.t7||0) - (p.t0||0)}ms`);
        log(`[PERF-END] ╚══════════════════════════════════════════════════════╝`);
        timingMap.delete(messageId);
      });
      return;
    }

    // 检查 session 状态（仅变化时记录）
    pollCount++;
    if (pollCount % 20 === 0) {
      log(`[handleFeishuEvent] [心跳] 已轮询${pollCount}次, elapsed=${Math.floor(elapsed / 1000)}s, watchHits=${watchHitCount}, status=${status || '未知'}`);
    }
    try {
      status = await vscode.commands.executeCommand('icube.chat.getSessionRunningStatus');
      if (status !== lastStatus) {
        log(`[handleFeishuEvent] [状态变化] ${lastStatus || '(初始)'} → ${status} (${Math.floor(elapsed / 1000)}s, poll#${pollCount})`);
        lastStatus = status;
      }
    } catch (e) {
      // 忽略偶发错误
    }
  }

  // 超时处理：先检查 sideband 文件是否已就绪，防止消息丢失
  log(`[handleFeishuEvent] [TIMEOUT] ${Math.floor((Date.now() - startTime) / 1000)}秒等待超时, 共轮询${pollCount}次, watch命中${watchHitCount}次, 检查 sideband 文件 (messageId=${messageId?.substring(0, 16)}...)`);

  // 给 Agent 额外 30 秒宽限期（Agent 可能刚好写完）
  for (let i = 0; i < 6; i++) {
    await sleep(5000);
    const fileExists = fs.existsSync(sidebandFile);
    log(`[handleFeishuEvent] [RETRY ${i + 1}/6] 宽限期等待中... 文件${fileExists ? '✅已出现' : '❌未出现'}`);
    if (fileExists) break;
  }

  if (fs.existsSync(sidebandFile)) {
    // 文件已就绪，尝试读取并发送实际回复
    log(`[handleFeishuEvent] [RECOVERY] 宽限期后发现 sideband 文件，尝试读取回复...`);
    try {
      const replyContent = fs.readFileSync(sidebandFile, 'utf8').trim();
      if (replyContent) {
        const t5 = Date.now();
        timingMap.set(messageId, { ...timingMap.get(messageId), t5 });
        // 双重读取校验
        await sleep(50);
        const secondRead = fs.readFileSync(sidebandFile, 'utf8').trim();
        if (secondRead.length === replyContent.length) {
          log(`[handleFeishuEvent] [RECOVERY] ✅ 读取成功 (${replyContent.length} 字符), 发送到飞书`);
          fs.unlinkSync(sidebandFile);
          const t6 = Date.now();
          sendFeishuReply(replyContent).then(() => {
            const t7 = Date.now();
            timingMap.set(messageId, { ...timingMap.get(messageId), t6, t7 });
            const p = timingMap.get(messageId) || {};
            log(`[PERF-END] ╔══════════════════════════════════════════════════════╗`);
            log(`[PERF-END] ║ 飞书消息处理完成 (RECOVERY路径)`);
            log(`[PERF-END] ║ messageId: ${messageId?.substring(0, 16)}...`);
            log(`[PERF-END] ║ T0→T1 入队→处理: ${(p.t1||0) - (p.t0||0)}ms`);
            log(`[PERF-END] ║ T1→T2 处理→发送: ${(p.t2||0) - (p.t1||0)}ms`);
            log(`[PERF-END] ║ T2→T3 发送→完成: ${(p.t3||0) - (p.t2||0)}ms`);
            log(`[PERF-END] ║ T3→T4 完成→等待: ${(p.t4||0) - (p.t3||0)}ms`);
            log(`[PERF-END] ║ T4→T5 等待→文件: ${(p.t5||0) - (p.t4||0)}ms`);
            log(`[PERF-END] ║ T5→T7 文件→飞书: ${(p.t7||0) - (p.t5||0)}ms`);
            log(`[PERF-END] ║ TOTAL T0→T7: ${(p.t7||0) - (p.t0||0)}ms`);
            log(`[PERF-END] ╚══════════════════════════════════════════════════════╝`);
            timingMap.delete(messageId);
          });
          return;
        } else {
          log(`[handleFeishuEvent] [RECOVERY] ⚠️ 文件仍在写入中 (首次${replyContent.length}字节, 二次${secondRead.length}字节), 尝试直接发送`);
          fs.unlinkSync(sidebandFile);
          sendFeishuReply(replyContent).then(() => {
            const t7 = Date.now();
            const p = timingMap.get(messageId) || {};
            log(`[PERF-END] [RECOVERY-部分] TOTAL T0→${t7}ms (直接发送, ${(p.t5||0) - (p.t4||0)}ms等待)`);
            timingMap.delete(messageId);
          });
          return;
        }
      }
    } catch (e) {
      log(`[handleFeishuEvent] [RECOVERY] ❌ 读取失败: ${e.message?.substring(0, 80)}`);
    }
    // 文件存在但读失败，清理并报错
    if (fs.existsSync(sidebandFile)) {
      try { fs.unlinkSync(sidebandFile); } catch (e) { /* 忽略 */ }
      log(`[handleFeishuEvent] [RECOVERY] 已清理损坏的 sideband 文件`);
    }
  }

  // 文件不存在，发送超时通知
  const tTimeout = Date.now();
  const p = timingMap.get(messageId) || {};
  log(`[handleFeishuEvent] [TIMEOUT] ❌ sideband 文件始终未出现, 发送超时通知到飞书 (messageId=${messageId?.substring(0, 16)}...)`);
  log(`[PERF-END] ╔══════════════════════════════════════════════════════╗`);
  log(`[PERF-END] ║ 飞书消息处理超时`);
  log(`[PERF-END] ║ messageId: ${messageId?.substring(0, 16)}...`);
  log(`[PERF-END] ║ T0→T1 入队→处理: ${(p.t1||0) - (p.t0||0)}ms`);
  log(`[PERF-END] ║ T1→T2 处理→发送: ${(p.t2||0) - (p.t1||0)}ms`);
  log(`[PERF-END] ║ T2→T3 发送→完成: ${(p.t3||0) - (p.t2||0)}ms`);
  log(`[PERF-END] ║ T3→T4 完成→等待: ${(p.t4||0) - (p.t3||0)}ms`);
  log(`[PERF-END] ║ T4→TIMEOUT: ${tTimeout - (p.t4||tTimeout)}ms (轮询+宽限期)`);
  log(`[PERF-END] ║ TOTAL T0→TIMEOUT: ${tTimeout - (p.t0||tTimeout)}ms`);
  log(`[PERF-END] ╚══════════════════════════════════════════════════════╝`);
  timingMap.delete(messageId);
  await sendFeishuReply('（Agent 回复读取超时，请重新发送消息）');
}

function sendFeishuReply(replyText) {
  const textLength = replyText?.length || 0;
  log(`[sendFeishuReply] 准备发送回复: ${textLength} 字符, 前50字符: "${replyText?.substring(0, 50)}"`);
  return new Promise((resolve) => {
    // 使用 --content 参数（JSON 格式），安全处理特殊字符
    const contentJson = JSON.stringify({ text: replyText });
    const args = [
      '--profile', PATHS.LARK_PROFILE,
      'im', '+messages-send',
      '--as', 'bot',
      '--user-id', PATHS.FEISHU_USER_ID,
      '--content', contentJson
    ];

    execFile(PATHS.LARK_CLI, args, { maxBuffer: 1024 * 1024, windowsHide: true }, (error, stdout, stderr) => {
      if (error) {
        log(`[sendFeishuReply] ❌ 飞书回复失败: ${error.message?.substring(0, 100)}`);
        if (stderr) log(`[sendFeishuReply] stderr: ${stderr?.substring(0, 200)}`);
      } else {
        try {
          const result = JSON.parse(stdout.trim().split('\n').pop());
          if (result.ok) {
            log(`[sendFeishuReply] ✅ 回复已发送到飞书 (message_id: ${result.data?.message_id?.substring(0, 16)}..., text=${textLength}字符)`);
          } else {
            log(`[sendFeishuReply] ⚠️ 飞书回复返回非ok: ${stdout?.substring(0, 150)}`);
          }
        } catch (e) {
          log(`[sendFeishuReply] ✅ 回复已发送 (非JSON响应): ${stdout?.substring(0, 80)}`);
        }
      }
      resolve();
    });
  });
}

function activate(context) {
  PATHS = initPaths();
  outputChannel = vscode.window.createOutputChannel('Trae Feishu Bridge');

  log('========================================');
  log('Trae Feishu Bridge 扩展已激活');
  log(`版本: 0.1.1 (Session 智能复用 + 全链路日志 + PERF 计时)`);
  log(`激活时间: ${new Date().toISOString()}`);
  log(`lark-cli: ${PATHS.LARK_CLI || '(未找到)'}`);
  log(`工作目录: ${PATHS.WORK_DIR}`);
  log('========================================');
  log('');

  // 恢复持久化的 session 状态
  loadSessionState();

  log('');
  log('可用命令:');
  log('  - XiaoT1 Bridge: Health Check (健康检查)');
  log('  - XiaoT1 Bridge: Test Chat Send (Clipboard Hack)');
  log('  - XiaoT1 Bridge: Test Chat Send (icube Native API) ← 推荐');
  log('  - XiaoT1 Bridge: Probe APIs (探索可用接口)');
  log('  - XiaoT1 Bridge: Probe Feishu Bridge (探测原生飞书桥)');
  log('  - XiaoT1 Bridge: Start Full Bridge (启动完整飞书桥接) ← 新');
  log('  - XiaoT1 Bridge: Stop Full Bridge (停止飞书桥接) ← 新');
  log('  - XiaoT1 Bridge: Reset Feishu Session (重置飞书持久会话) ← v0.1.0+');
  log('');
  log('飞书指令: /新对话 或 /reset 可在飞书中重置会话');
  log('');
  log('通过 Ctrl+Shift+P 搜索 "XiaoT1" 调用');
  log('');

  const healthCmd = vscode.commands.registerCommand('xiaot1.bridge.health', healthCheck);
  const testCmd = vscode.commands.registerCommand('xiaot1.bridge.test', testChatSend);
  const testIcubeCmd = vscode.commands.registerCommand('xiaot1.bridge.testIcube', testIcubeSend);
  const probeCmd = vscode.commands.registerCommand('xiaot1.bridge.probe', probeApis);
  const probeFeishuCmd = vscode.commands.registerCommand('xiaot1.bridge.probeFeishu', probeFeishuBridge);
  const startCmd = vscode.commands.registerCommand('xiaot1.bridge.start', startFullBridge);
  const stopCmd = vscode.commands.registerCommand('xiaot1.bridge.stop', stopFullBridge);
  const resetSessionCmd = vscode.commands.registerCommand('xiaot1.bridge.resetSession', () => {
    resetFeishuSession('手动重置 (命令面板)');
    vscode.window.showInformationMessage('XiaoT1 Bridge: 飞书 session 已重置');
  });

  context.subscriptions.push(healthCmd, testCmd, testIcubeCmd, probeCmd, probeFeishuCmd, startCmd, stopCmd, resetSessionCmd);
}

function deactivate() {
  if (bridgeProcess) {
    try { bridgeProcess.kill(); } catch (e) { /* 忽略 */ }
    bridgeProcess = null;
  }
  // 持久化 session 状态，重启后恢复
  saveSessionState();
  if (outputChannel) {
    log('XiaoT1 Bridge 扩展已停用 (session 状态已持久化)');
  }
}

module.exports = { activate, deactivate };
