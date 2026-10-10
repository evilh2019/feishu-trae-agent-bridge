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
  // Bridge 工作目录（留空使用用户主目录下的 feishu-trae-agent-bridge）
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
  // 优先扫描「版本号目录」（Trae 升级后目录名会变，如 1.0.3 → 1.0.4），取最新版本
  const larkBases = [
    path.join(os.homedir(), '.trae-cn', 'plugins', 'trae-remote-official', 'lark'),
    path.join(os.homedir(), '.trae-cn', 'plugins', 'lark'),
  ];
  for (const base of larkBases) {
    const found = scanLarkVersionDir(base);
    if (found) return found;
  }
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

// 扫描形如 1.2.3 的版本目录，返回最新版本下的 lark-cli.exe
function scanLarkVersionDir(base) {
  try {
    if (!fs.existsSync(base)) return null;
    const versions = fs.readdirSync(base)
      .filter((n) => /^\d+\.\d+\.\d+$/.test(n))
      .sort((a, b) => {
        const pa = a.split('.').map(Number);
        const pb = b.split('.').map(Number);
        for (let i = 0; i < 3; i++) {
          if (pa[i] !== pb[i]) return pb[i] - pa[i];
        }
        return 0;
      });
    for (const v of versions) {
      const p = path.join(base, v, 'bin', 'lark-cli.exe');
      if (fs.existsSync(p)) return p;
    }
  } catch (e) { /* 忽略 */ }
  return null;
}

// ========== 初始化配置 ==========
function initPaths() {
  const os = require('os');
  const workDir = CONFIG.WORK_DIR || path.join(os.homedir(), 'feishu-trae-agent-bridge');
  if (!fs.existsSync(workDir)) fs.mkdirSync(workDir, { recursive: true });
  const repliesDir = path.join(workDir, 'replies');
  if (!fs.existsSync(repliesDir)) fs.mkdirSync(repliesDir, { recursive: true });

  return {
    LARK_CLI: findLarkCli(),
    LARK_PROFILE: CONFIG.LARK_PROFILE,
    FEISHU_USER_ID: CONFIG.FEISHU_USER_ID,
    REPLIES_DIR: repliesDir,
    SESSION_STATE_FILE: path.join(workDir, 'session_state.json'),
    BRIDGE_PID_FILE: path.join(workDir, 'bridge.pid'),
    BRIDGE_TIMEOUT: CONFIG.BRIDGE_TIMEOUT,
    LOG_FILE: path.join(workDir, 'bridge.log'),
    WORK_DIR: workDir,
  };
}

let PATHS; // 运行时配置，由 activate() 初始化

let bridgeProcess = null;
let isBridgeRunning = false;
let bridgeManuallyStopped = false;   // 手动停止标志：为 true 时不自动重启
let bridgeRestartTimer = null;      // 自动重启定时器
let bridgeRestartAttempts = 0;      // 连续重启次数（用于指数退避）
const BRIDGE_RESTART_BASE_DELAY = 3000;   // 自动重启基础延迟（毫秒）
const BRIDGE_RESTART_MAX_DELAY = 60000;   // 自动重启最大退避延迟（毫秒）
let processedEventIds = new Set();  // 事件去重
let messageQueue = [];  // 消息处理队列
let isProcessing = false;  // 是否正在处理消息
let replyWatcher = null;  // fs.watch 目录监听器
let watchDetectedFiles = new Set();  // fs.watch 检测到的待处理文件
let timingMap = new Map();  // 消息各阶段时间戳 { messageId: { t0, t1, t2, ... } }

// ========== 通用扩展点：入站拦截器（供独立「增强扩展」注册；本扩展不含任何具体增强逻辑）==========
// 增强扩展侧用法：
//   const api = vscode.extensions.getExtension('<基座扩展 id>').exports;
//   api.registerInboundInterceptor(async (content) => '要前插到消息前的文本，或返回空串');
// 拦截器在每条入站消息进入 Trae Agent 会话前被 await 调用，返回值前插到 agentMessage；异常一律捕获（fail-safe）。
const inboundInterceptors = [];
function registerInboundInterceptor(fn) {
  if (typeof fn !== 'function') throw new TypeError('registerInboundInterceptor: fn 必须是函数');
  inboundInterceptors.push(fn);
  return { dispose() { const i = inboundInterceptors.indexOf(fn); if (i >= 0) inboundInterceptors.splice(i, 1); } };
}

// ========== 网关：适配器注册表 + 出站钩子（通用；本块不含任何具体传输逻辑）==========
// 设计见 docs/gateway-architecture.md §四：
//   传输 adapter  = { id, configure?(cfg), start?(ctx), stop?() }  —— 每个外部系统一个，自己管连接/收发
//   出站钩子 hook = (reply, ctx) -> Promise<string>               —— 只改"回复文本"，不碰传输
// 每个 adapter 的 start/stop 独立 try/catch（错误隔离）：一个 adapter 崩溃不影响其它 adapter 与主链路。
const adapterRegistry = new Map();   // id -> { adapter, running, startedAt }
const outboundHooks = [];

function registerAdapter(adapter) {
  if (!adapter || typeof adapter !== 'object') throw new TypeError('registerAdapter: adapter 必须是对象');
  if (!adapter.id || typeof adapter.id !== 'string') throw new TypeError('registerAdapter: adapter.id 必填');
  if (adapterRegistry.has(adapter.id)) {
    log(`[gateway] 适配器已存在，忽略重复注册: ${adapter.id}`);
    return adapterRegistry.get(adapter.id).adapter;
  }
  adapterRegistry.set(adapter.id, { adapter, running: false, startedAt: null });
  log(`[gateway] 已注册适配器: ${adapter.id}`);
  return adapter;
}

function listAdapters() {
  return Array.from(adapterRegistry.values()).map((e) => ({ id: e.adapter.id, running: e.running, startedAt: e.startedAt }));
}

async function startAdapter(id) {
  const entry = adapterRegistry.get(id);
  if (!entry) { log(`[gateway] startAdapter: 未知适配器 ${id}`); return false; }
  if (entry.running) { log(`[gateway] 适配器已在运行: ${id}`); return true; }
  try {
    if (typeof entry.adapter.configure === 'function') entry.adapter.configure({ logger: log });
    if (typeof entry.adapter.start === 'function') await entry.adapter.start({ logger: log });
    entry.running = true;
    entry.startedAt = Date.now();
    log(`[gateway] ✅ 适配器已启动: ${id}`);
    return true;
  } catch (err) {
    // 错误隔离：单个 adapter 启动失败只记日志、不抛出，不影响调用方与其它 adapter
    entry.running = false;
    log(`[gateway] ❌ 适配器启动失败（已隔离）: ${id}, error=${err && err.message ? err.message.substring(0, 120) : err}`);
    return false;
  }
}

async function stopAdapter(id) {
  const entry = adapterRegistry.get(id);
  if (!entry) { log(`[gateway] stopAdapter: 未知适配器 ${id}`); return false; }
  try {
    if (typeof entry.adapter.stop === 'function') await entry.adapter.stop();
    log(`[gateway] 适配器已停止: ${id}`);
  } catch (err) {
    log(`[gateway] ⚠️ 适配器停止异常（已隔离）: ${id}, error=${err && err.message ? err.message.substring(0, 120) : err}`);
  }
  entry.running = false;
  return true;
}

// 逐个启动/停止；各自 try/catch，互为隔离
async function startAllAdapters() {
  for (const id of adapterRegistry.keys()) await startAdapter(id);
}
async function stopAllAdapters() {
  for (const id of adapterRegistry.keys()) await stopAdapter(id);
}

function registerOutboundHook(fn) {
  if (typeof fn !== 'function') throw new TypeError('registerOutboundHook: fn 必须是函数');
  outboundHooks.push(fn);
  return { dispose() { const i = outboundHooks.indexOf(fn); if (i >= 0) outboundHooks.splice(i, 1); } };
}

// 依次 await 各出站钩子加工回复文本；best-effort，任何异常只记日志并保留上一步文本
async function applyOutboundHooks(reply, ctx) {
  let out = reply;
  for (const fn of outboundHooks) {
    try {
      const r = await fn(out, ctx);
      if (typeof r === 'string') out = r;
    } catch (e) {
      log(`[gateway] 出站钩子异常（已忽略）: ${e && e.message ? e.message.substring(0, 120) : e}`);
    }
  }
  return out;
}

// ========== 飞书持久 Session 管理（按对话 chat_id 隔离，每个飞书对话固定一个 Trae 会话） ==========
let feishuSessionId = null;        // 当前处理对话的 session ID（处理前由 chatSessions 载入）
let feishuSessionLastUsed = 0;      // session 最后使用时间戳
const chatSessions = new Map();     // chat_id -> { sessionId, lastUsed }
const DEFAULT_CHAT_KEY = 'default'; // 事件缺 chat_id 时的兜底 key
let activeChatId = '';              // 当前正在处理的飞书对话 id（队列串行处理，供回复路由使用）
const pendingNewChats = new Set();  // 收到 /new 或超时重置后，该对话下一条消息强制新建 session
const SESSION_RESET_TIMEOUT = 12 * 60 * 60 * 1000;  // 12 小时无消息自动重置（放宽阈值，避免因消息间隔而频繁丢上下文）
const MAX_RETRIES = 10;              // Agent 无回复（如模型 503 空回复）时，最多自动重发 10 次
const FIRST_WAIT_MS = 600000;        // 首轮等待窗口（容纳长任务）
const RETRY_WAIT_MS = 45000;         // 重试轮次等待窗口（失败后快速重发）
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
  vscode.window.showInformationMessage('Feishu Trae Agent Bridge: 健康检查完成，查看 Output 面板');
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
    vscode.window.showInformationMessage('Feishu Trae Agent Bridge: icube 测试完成，查看 Output');

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
  vscode.window.showInformationMessage('Feishu Trae Agent Bridge: API 探测完成，查看 Output');
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
    vscode.window.showInformationMessage('Feishu Trae Agent Bridge: 测试完成，请检查 chat 面板');

  } catch (error) {
    log(`[ERROR] ${error.message}`);
    if (error.stack) log(error.stack);
    outputChannel.show(true);
    vscode.window.showErrorMessage(`Feishu Trae Agent Bridge 测试失败: ${error.message}`);
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
      appId: 'APP_ID_PLACEHOLDER',
      appSecret: 'APP_SECRET_PLACEHOLDER',
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
      { label: 'login({appId, appSecret})', args: [{ appId: 'APP_ID_PLACEHOLDER', appSecret: 'APP_SECRET_PLACEHOLDER' }] },
      { label: 'login({app_id, app_secret})', args: [{ app_id: 'APP_ID_PLACEHOLDER', app_secret: 'APP_SECRET_PLACEHOLDER' }] },
      { label: 'login({appId, appSecret, brand})', args: [{ appId: 'APP_ID_PLACEHOLDER', appSecret: 'APP_SECRET_PLACEHOLDER', brand: 'feishu' }] },
      { label: 'login("APP_ID_PLACEHOLDER", "APP_SECRET_PLACEHOLDER")', args: ['APP_ID_PLACEHOLDER', 'APP_SECRET_PLACEHOLDER'] },
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
      app_id: 'APP_ID_PLACEHOLDER',
      app_secret: 'APP_SECRET_PLACEHOLDER',
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
      { label: 'sessionBind.login("APP_ID_PLACEHOLDER")', args: ['APP_ID_PLACEHOLDER'] },
      { label: 'sessionBind.login("APP_ID_PLACEHOLDER", "APP_SECRET_PLACEHOLDER")', args: ['APP_ID_PLACEHOLDER', 'APP_SECRET_PLACEHOLDER'] },
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
  vscode.window.showInformationMessage('Feishu Trae Agent Bridge: 飞书桥探测完成，查看 Output');
}

// ========== 完整飞书桥接链路 ==========

async function startFullBridge(opts) {
  const isRestart = !!(opts && opts.isRestart === true);
  log(isRestart ? '=== [保活] 自动重启完整飞书桥接 ===' : '=== 启动完整飞书桥接 ===');

  // 清除手动停止标志（允许后续保活自动重启）
  bridgeManuallyStopped = false;

  // 重新探测 lark-cli 路径（兼容 Trae 升级后版本目录变化）
  const detected = findLarkCli();
  if (detected) {
    if (detected !== PATHS.LARK_CLI) log(`[lark-cli] 自动探测到路径: ${detected}`);
    PATHS.LARK_CLI = detected;
  }

  // 确保 session 状态已从文件恢复（覆盖 activate 之后可能的变更）
  loadSessionState();

  if (isBridgeRunning) {
    log('桥接已在运行，先停止...');
    stopFullBridge();
    await sleep(1000);
    bridgeManuallyStopped = false;  // stopFullBridge 会置 true，这里重新清除
  }

  // 创建 replies 目录
  if (!fs.existsSync(PATHS.REPLIES_DIR)) {
    fs.mkdirSync(PATHS.REPLIES_DIR, { recursive: true });
    log(`创建 replies 目录: ${PATHS.REPLIES_DIR}`);
  }

  // 清理旧的 sideband 文件（仅手动启动时清理；自动重启时保留，避免误删正在处理的回复）
  if (!isRestart) {
    try {
      const oldFiles = fs.readdirSync(PATHS.REPLIES_DIR);
      for (const f of oldFiles) {
        fs.unlinkSync(path.join(PATHS.REPLIES_DIR, f));
      }
      log(`清理 ${oldFiles.length} 个旧 sideband 文件`);
    } catch (e) { /* 忽略 */ }
  } else {
    log('[保活] 自动重启，跳过 sideband 文件清理');
  }

  // 启动 fs.watch 目录监听（零延迟检测 sideband 文件）
  setupReplyWatcher();

  // 启动 lark-cli event consume
  const args = [
    '--profile', PATHS.LARK_PROFILE,
    'event', 'consume', 'im.message.receive_v1',
    '--as', 'bot',
    '--timeout', PATHS.BRIDGE_TIMEOUT
  ];

  // 启动前清理上一轮可能残留的孤儿 lark-cli（Trae 异常退出时会残留）
  await killOrphanLarkCli();

  log(`启动 lark-cli: ${PATHS.LARK_CLI} ${args.join(' ')}`);
  bridgeProcess = spawn(PATHS.LARK_CLI, args, {
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true
  });
  isBridgeRunning = true;

  // 记录当前 PID，供下次启动清理孤儿进程
  try {
    fs.writeFileSync(PATHS.BRIDGE_PID_FILE, String(bridgeProcess.pid), 'utf8');
  } catch (e) { /* 忽略 */ }

  log(`lark-cli event consume 已启动 (PID: ${bridgeProcess.pid})`);
  log('等待飞书消息...');
  log('发送 "Feishu Trae Agent Bridge: Stop Full Bridge" 命令停止');
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
    // 连接成功 → 重置退避计数
    if (msg.includes('connected') || msg.includes('ready event_key')) {
      if (bridgeRestartAttempts > 0) {
        log(`[保活] 连接已恢复，重置重启计数 (原 ${bridgeRestartAttempts} 次)`);
        bridgeRestartAttempts = 0;
      }
    }
  });

  bridgeProcess.on('error', (err) => {
    log(`[保活] lark-cli 进程错误: ${err.message}`);
    isBridgeRunning = false;
    bridgeProcess = null;
    if (!bridgeManuallyStopped) scheduleBridgeRestart(-1, 'spawn-error');
  });

  bridgeProcess.on('exit', (code, signal) => {
    log(`lark-cli event consume 已退出 (code: ${code}, signal: ${signal})`);
    isBridgeRunning = false;
    bridgeProcess = null;
    // 非手动停止 → 自动重启（保活）
    if (bridgeManuallyStopped) {
      log('[保活] 手动停止，不自动重启');
    } else {
      scheduleBridgeRestart(code, signal);
    }
  });

  // 启动队列处理器
  processQueue();

  outputChannel.show(true);
  vscode.window.showInformationMessage('Feishu Trae Agent Bridge: 完整桥接已启动，等待飞书消息');
}

function stopFullBridge() {
  // 标记为手动停止：阻止保活机制自动重启
  bridgeManuallyStopped = true;
  if (bridgeRestartTimer) {
    clearTimeout(bridgeRestartTimer);
    bridgeRestartTimer = null;
    log('[保活] 已取消待执行的重启');
  }
  cleanupReplyWatcher();
  if (bridgeProcess) {
    log('停止 lark-cli event consume...');
    try {
      bridgeProcess.kill();
    } catch (e) { /* 忽略 */ }
    bridgeProcess = null;
    isBridgeRunning = false;
    log('桥接已停止');
    vscode.window.showInformationMessage('Feishu Trae Agent Bridge: 桥接已停止');
  } else {
    log('桥接未运行');
  }
  messageQueue = [];
  isProcessing = false;
}

// 内置适配器：飞书。传输逻辑仍在本扩展原位（startFullBridge/stopFullBridge），此处仅包一层描述符注册进网关。
const feishuAdapter = {
  id: 'feishu',
  configure() { /* 预留：适配器级配置 */ },
  start() { return startFullBridge(); },
  stop() { return stopFullBridge(); }
};

// 保活：安排自动重启（指数退避，最长 BRIDGE_RESTART_MAX_DELAY）
function scheduleBridgeRestart(code, signal) {
  if (bridgeManuallyStopped) {
    log('[保活] 已手动停止，不重启');
    return;
  }
  if (bridgeRestartTimer) {
    log('[保活] 已有待执行的重启计划，跳过');
    return;
  }
  bridgeRestartAttempts++;
  const delay = Math.min(
    BRIDGE_RESTART_BASE_DELAY * Math.pow(2, bridgeRestartAttempts - 1),
    BRIDGE_RESTART_MAX_DELAY
  );
  log(`[保活] lark-cli 已退出 (code=${code}, signal=${signal})，${delay}ms 后自动重启 (第 ${bridgeRestartAttempts} 次)`);
  bridgeRestartTimer = setTimeout(() => {
    bridgeRestartTimer = null;
    if (bridgeManuallyStopped) {
      log('[保活] 定时器触发时已手动停止，取消重启');
      return;
    }
    if (isBridgeRunning) {
      log('[保活] 桥接已在运行，取消本次重启');
      return;
    }
    log('[保活] 正在自动重启桥接...');
    startFullBridge({ isRestart: true }).catch((e) => log(`[保活] 自动重启失败: ${e.message}`));
  }, delay);
}

// ========== 孤儿进程清理 ==========
// Trae 异常退出时子进程 lark-cli 可能残留，导致下次启动出现双连接（消息重复）。
// 策略：启动前读取上次记录的 PID，先校验其进程名确为 lark-cli.exe 再清理，避免误杀被回收的 PID。
function execFileAsync(cmd, args) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, (err, stdout) => {
      if (err) reject(err);
      else resolve(stdout);
    });
  });
}

// 查询指定 PID 的进程名；进程不存在时返回 null
function getProcessName(pid) {
  return new Promise((resolve) => {
    execFile('tasklist', ['/FI', `PID eq ${pid}`, '/FO', 'CSV', '/NH'], (err, stdout) => {
      if (err || !stdout) return resolve(null);
      const line = stdout.trim();
      if (!line || line.startsWith('INFO:')) return resolve(null);
      const m = line.match(/^"([^"]+)"/);
      resolve(m ? m[1] : null);
    });
  });
}

async function killOrphanLarkCli() {
  let oldPid = null;
  try {
    if (fs.existsSync(PATHS.BRIDGE_PID_FILE)) {
      oldPid = parseInt(fs.readFileSync(PATHS.BRIDGE_PID_FILE, 'utf8').trim(), 10);
    }
  } catch (e) { /* 忽略 */ }

  if (!oldPid || Number.isNaN(oldPid)) {
    log('[孤儿清理] 无历史 PID 记录，跳过');
    return;
  }

  const name = await getProcessName(oldPid);
  if (!name) {
    log(`[孤儿清理] 历史 PID ${oldPid} 已不存在，无需清理`);
    return;
  }
  if (!name.toLowerCase().includes('lark-cli')) {
    log(`[孤儿清理] 历史 PID ${oldPid} 现为 "${name}"，非 lark-cli，跳过（避免误杀）`);
    return;
  }

  log(`[孤儿清理] 发现残留 lark-cli 进程 (PID ${oldPid})，正在清理...`);
  try {
    await execFileAsync('taskkill', ['/F', '/PID', String(oldPid)]);
    log(`[孤儿清理] ✅ 残留进程 PID ${oldPid} 已清理`);
  } catch (e) {
    log(`[孤儿清理] 清理失败: ${e.message}`);
  }
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

    // 兼容：旧版单会话格式（顶层 feishuSessionId）无法判断归属哪个对话，忽略并空状态启动
    if (!data || !data.chats || typeof data.chats !== 'object') {
      log(`[Session] [load] ⚠️ 无 chats 映射（旧格式或空文件），按空状态启动`);
      return false;
    }

    const now = Date.now();
    let restored = 0;
    for (const [chatKey, entry] of Object.entries(data.chats)) {
      if (!entry || !entry.sessionId) continue;
      if (entry.lastUsed && now - entry.lastUsed > SESSION_RESET_TIMEOUT) {
        log(`[Session] [load] 对话 ${chatKey.substring(0, 12)}... 的 session 已超时，丢弃`);
        continue;
      }
      chatSessions.set(chatKey, { sessionId: entry.sessionId, lastUsed: entry.lastUsed || 0 });
      restored++;
    }
    log(`[Session] [load] ✅ 恢复 ${restored} 个对话的 session 映射`);
    return restored > 0;
  } catch (e) {
    log(`[Session] [load] ❌ 加载失败: ${e.message}`);
    log(`[Session] [load] 错误堆栈: ${e.stack?.substring(0, 300) || '无'}`);
    return false;
  }
}

function saveSessionState() {
  log(`[Session] [save] 开始持久化 session 状态 (${chatSessions.size} 个对话)`);

  try {
    if (chatSessions.size === 0) {
      log(`[Session] [save] ⚠️ 无对话 session，跳过保存`);
      return;
    }

    const chats = {};
    for (const [chatKey, entry] of chatSessions) {
      if (entry && entry.sessionId) chats[chatKey] = { sessionId: entry.sessionId, lastUsed: entry.lastUsed || 0 };
    }
    const data = { version: 2, chats, savedAt: Date.now() };

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
  chatSessions.clear();
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

// chatKey 缺省时重置全部对话（命令面板手动重置）；否则只重置指定对话
function resetFeishuSession(reason, chatKey) {
  if (chatKey) {
    const oldId = chatSessions.get(chatKey)?.sessionId || null;
    chatSessions.delete(chatKey);
    saveSessionState();
    log(`[Session] 重置对话 ${chatKey.substring(0, 12)} 的 session (原因: ${reason || '未说明'})${oldId ? ', 旧 session: ' + oldId.substring(0, 12) + '...' : ''}`);
  } else {
    clearSessionState();
    log(`[Session] 重置全部对话 session (原因: ${reason || '未说明'})`);
  }
}

async function trySendToAgent(message, sidebandFile, chatKey, rawContent) {
  const key = chatKey || DEFAULT_CHAT_KEY;
  // 1. 检查是否为 session 重置指令（比对用户原始输入，而非包装后的 agent 消息）
  const strippedMsg = (rawContent || '').trim();
  if (SESSION_RESET_COMMANDS.some(cmd => strippedMsg === cmd)) {
    resetFeishuSession('用户指令', chatKey);
    pendingNewChats.add(key);  // 下一条消息强制新建，避免被“复用当前面板会话”策略抢回旧话题
    return { resetCommand: true, replyText: '已重置对话，新消息将创建新 session' };
  }

  // 2. 检查 session 超时（阈值已放宽到 12 小时，正常使用不会因间隔而丢上下文）
  if (feishuSessionId && Date.now() - feishuSessionLastUsed > SESSION_RESET_TIMEOUT) {
    resetFeishuSession(`超时 (${SESSION_RESET_TIMEOUT / 3600000}小时无消息)`, chatKey);
    pendingNewChats.add(key);  // 超时后同样强制新建
  }

  // 强制新建标记：仅 /new、重置或超时后的首条消息为 true
  const forceNew = pendingNewChats.has(key);

  // 3. 复用已有 session —— 关键约束：agent 只在「当前聚焦的面板会话」里运行。
  //    定向发往后台存档会话只会写入历史、不触发 agent（返回无 sessionId）。
  //    因此策略：仅当确认落到「能运行的会话」才算复用成功；否则回退到当前聚焦面板保证一定回复。
  let sendResult = null;
  let currentSession = null;
  let landedSessionId = null;   // 本条消息最终确认落入的 session
  try {
    currentSession = (await vscode.commands.executeCommand('icube.chat.getCurrentSessionId')) || null;
  } catch (e) {
    log(`[Session] 读取当前会话失败: ${e.message?.substring(0, 50)}`);
  }
  if (forceNew) {
    log('[Session] 已标记强制新建（/new 或重置）');
  } else {
    log(`[Session] 当前面板会话: ${currentSession ? currentSession.substring(0, 12) + '...' : '(无)'}；已存 session: ${feishuSessionId ? feishuSessionId.substring(0, 12) + '...' : '(无)'}`);
  }

  // A. 有存档且未强制新建 → 尝试复用
  let reused = false;
  if (feishuSessionId && !forceNew) {
    if (currentSession === feishuSessionId) {
      // A-1. 存档会话恰是当前聚焦面板 → 直接发送，agent 必然运行
      log('[Session] ✅ 当前面板即目标会话，直接发送（复用）');
      try {
        sendResult = (await vscode.commands.executeCommand(
          'icube.chat.sendToAgentNonBlocking',
          [message],
          { enableUnstableFields: true }
        )) || {};
        reused = true;
        landedSessionId = sendResult?.sessionId || feishuSessionId;
      } catch (e) {
        log(`[Session] 复用发送失败: ${e.message?.substring(0, 60)}`);
        sendResult = null;
      }
    } else {
      // A-2. 存档会话非当前面板 → 单次后台定向发送；只有返回同 id 才视为真正触发
      log(`[Session] 当前面板非目标会话，单次定向发送到存档 session: ${feishuSessionId.substring(0, 12)}...`);
      try {
        const r = await vscode.commands.executeCommand(
          'icube.chat.sendToAgentNonBlocking',
          [message],
          { enableUnstableFields: true, sessionId: feishuSessionId }
        );
        const gotId = r?.sessionId || null;
        log(`[Session] 定向发送返回 sessionId: ${gotId ? gotId.substring(0, 12) + '...' : '无'}`);
        if (gotId && gotId === feishuSessionId) {
          sendResult = r;
          reused = true;
          landedSessionId = gotId;
        } else {
          log('[Session] ⚠️ 后台会话未触发 agent（无返回 id），消息可能被静默丢弃 → 将回退当前面板重发');
        }
      } catch (e) {
        log(`[Session] 定向发送失败: ${e.message?.substring(0, 60)}`);
      }
    }
  }

  // B. 复用未成功 → 回退：优先发到「当前聚焦面板」（agent 必运行）；无面板/回退失败才新建
  if (!reused) {
    if (!forceNew && currentSession) {
      log(`[Session] ⚠️ 存档会话不可运行${feishuSessionId ? '（' + feishuSessionId.substring(0, 12) + '...）' : ''}，回退发送到当前面板: ${currentSession.substring(0, 12)}...`);
      try {
        sendResult = (await vscode.commands.executeCommand(
          'icube.chat.sendToAgentNonBlocking',
          [message],
          { enableUnstableFields: true }
        )) || {};
        landedSessionId = sendResult?.sessionId || currentSession;
      } catch (e) {
        log(`[Session] 回退发送到当前面板失败: ${e.message?.substring(0, 60)}`);
        sendResult = null;
      }
    }
    if (!sendResult) {
      // 首次消息 / /new 或重置 / 无当前面板 / 回退失败 → 新建
      const why = forceNew ? '强制新建 session' : (currentSession ? '回退失败，创建新 session' : '无当前面板，创建新 session');
      log(`[Session] ${why}`);
      try {
        sendResult = await vscode.commands.executeCommand(
          'icube.chat.sendToAgentNonBlocking',
          [message],
          { enableUnstableFields: true, newSession: true }
        );
        landedSessionId = sendResult?.sessionId || null;
        log(`[Session] 新 session 创建成功: ${landedSessionId ? landedSessionId.substring(0, 12) + '...' : '无'}`);
      } catch (e) {
        log(`[Session] 新建 session 失败: ${e.message?.substring(0, 60)}`);
        sendResult = null;
      }
    }
  }

  // C. 确认本条消息实际落入的 session，写回该对话专属映射（回读兜底）
  let finalSessionId = landedSessionId || sendResult?.sessionId || null;
  if (!finalSessionId) {
    try {
      const cur = (await vscode.commands.executeCommand('icube.chat.getCurrentSessionId')) || null;
      if (cur) {
        finalSessionId = cur;
        log(`[Session] 返回无 sessionId，回读当前会话: ${cur.substring(0, 12)}...`);
      } else if (feishuSessionId) {
        finalSessionId = feishuSessionId;
      }
    } catch (e) {
      log(`[Session] 回读当前会话失败: ${e.message?.substring(0, 50)}`);
      if (feishuSessionId) finalSessionId = feishuSessionId;
    }
  }
  if (finalSessionId) {
    if (finalSessionId !== feishuSessionId) {
      log(`[Session] 保存对话 ${key.substring(0, 12)} 的 session: ${finalSessionId.substring(0, 12)}...`);
    }
    feishuSessionId = finalSessionId;
    feishuSessionLastUsed = Date.now();
    chatSessions.set(key, { sessionId: finalSessionId, lastUsed: feishuSessionLastUsed });
    pendingNewChats.delete(key);  // 已成功发送，清除强制新建标记
    saveSessionState();
  }

  return { sendResult };
}

async function handleFeishuEvent(event, attempt = 1) {
  const content = event.content || '';
  const messageId = event.message_id || '';
  const senderId = event.sender_id || '';
  const chatType = event.chat_type || 'p2p';
  const chatId = event.chat_id || '';
  const eventId = event.event_id || '';
  // 按对话隔离：每个飞书对话（chat_id）固定映射到一个 Trae 会话
  const chatKey = chatId || DEFAULT_CHAT_KEY;

  // 载入该对话专属的 session（互不干扰），并记录当前对话 id 供回复路由
  const saved = chatSessions.get(chatKey);
  feishuSessionId = saved?.sessionId || null;
  feishuSessionLastUsed = saved?.lastUsed || 0;
  activeChatId = chatId;

  const t1 = Date.now();
  if (timingMap.has(messageId)) {
    const existing = timingMap.get(messageId);
    timingMap.set(messageId, { ...existing, t1 });
  }
  log(`[handleFeishuEvent] [PERF] T1 开始处理: ${t1}ms, 距T0=${t1 - (timingMap.get(messageId)?.t0 || t1)}ms, messageId=${messageId?.substring(0, 16)}...`);
  log(`[handleFeishuEvent] 开始处理: messageId=${messageId?.substring(0, 16)}..., chatType=${chatType}, chat=${chatKey?.substring(0, 12)}..., messageType=${event.message_type || 'text'}, content="${content?.substring(0, 50)}"`);

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
  // 通用扩展点：依次 await 各入站拦截器（增强扩展注册，如经验库召回）；best-effort，失败不阻塞
  let injectPrefix = '';
  if (inboundInterceptors.length > 0) {
    const tHook = Date.now();
    for (const fn of inboundInterceptors) {
      try {
        const seg = await fn(content);
        if (seg) injectPrefix += seg + '\n\n';
      } catch (e) {
        log(`[handleFeishuEvent] 入站拦截器异常（已忽略）: ${e.message?.substring(0, 120)}`);
      }
    }
    log(`[handleFeishuEvent] 入站拦截器: ${inboundInterceptors.length} 个, 前插 ${injectPrefix.length} 字符 (${Date.now() - tHook}ms)`);
  }
  const agentMessage = `${injectPrefix}[飞书消息] 用户说：${content}\n\n[系统指令] 请将回复内容写入文件：${sidebandFile}`;
  log(`[handleFeishuEvent] 准备发送到 Agent: messageId=${messageId?.substring(0, 16)}..., 当前 feishuSessionId=${feishuSessionId ? feishuSessionId.substring(0, 12) + '...' : 'null'}`);

  let sendResult = null;
  const t0 = timingMap.get(messageId)?.t0 || Date.now();
  const t2 = Date.now();
  timingMap.set(messageId, { ...timingMap.get(messageId), t0, t2 });
  try {
    log(`[handleFeishuEvent] [PERF] T2 开始发送Agent: ${t2}ms, 距T0=${t2 - t0}ms, messageId=${messageId?.substring(0, 16)}...`);
    const result = await trySendToAgent(agentMessage, sidebandFile, chatKey, content);
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
      log(`[handleFeishuEvent] 检测到对话 ${chatKey?.substring(0, 12)}... 有保存的 session (${feishuSessionId?.substring(0, 12)}...), 重置后重试...`);
      resetFeishuSession('复用失败', chatKey);
      try {
        const retryResult = await vscode.commands.executeCommand(
          'icube.chat.sendToAgentNonBlocking',
          [agentMessage],
          { enableUnstableFields: true, newSession: true }
        );
        feishuSessionId = retryResult?.sessionId || null;
        feishuSessionLastUsed = Date.now();
        if (feishuSessionId) chatSessions.set(chatKey, { sessionId: feishuSessionId, lastUsed: feishuSessionLastUsed });
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
  const maxWait = attempt === 1 ? FIRST_WAIT_MS : RETRY_WAIT_MS;
  log(`[handleFeishuEvent] 开始等待 Agent 回复 (sideband=${sidebandFile}, 第 ${attempt} 轮, 最大等待=${Math.floor(maxWait / 1000)}s, messageId=${messageId?.substring(0, 16)}...)`);
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

  // 无回复：若还有重试额度，自动重发消息继续等待（应对模型 503 等导致的空回复）
  if (attempt <= MAX_RETRIES) {
    log(`[handleFeishuEvent] [RETRY ${attempt}/${MAX_RETRIES}] ❌ 第 ${attempt} 轮无回复，自动重发（下一轮等待 ${Math.floor(RETRY_WAIT_MS / 1000)}s）...`);
    if (attempt === 1) {
      try { await sendFeishuReply(`（Agent 未响应，正在自动重试，最多 ${MAX_RETRIES} 次…）`); } catch (e) { /* 忽略 */ }
    }
    timingMap.delete(messageId);
    return handleFeishuEvent(event, attempt + 1);
  }

  // 重试次数用尽，进入宽限期兜底
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

  // 重试次数用尽，发送超时通知
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

async function sendFeishuReply(replyText) {
  // 网关出站边界：依次应用出站钩子（增强扩展可加工回复文本）；无钩子时零开销
  let outText = replyText;
  if (outboundHooks.length > 0) {
    const tHook = Date.now();
    outText = await applyOutboundHooks(replyText, { adapterId: 'feishu', peer: PATHS.FEISHU_USER_ID });
    log(`[sendFeishuReply] 出站钩子: ${outboundHooks.length} 个, ${replyText?.length || 0} → ${outText?.length || 0} 字符 (${Date.now() - tHook}ms)`);
  }
  const textLength = outText?.length || 0;
  log(`[sendFeishuReply] 准备发送回复: ${textLength} 字符, 前50字符: "${outText?.substring(0, 50)}"`);
  return new Promise((resolve) => {
    // 使用 --content 参数（JSON 格式），安全处理特殊字符
    const contentJson = JSON.stringify({ text: outText });
    // 路由：优先回复到消息来源对话（chat_id，群/单聊均可），无则回退到配置的单聊用户
    const args = [
      '--profile', PATHS.LARK_PROFILE,
      'im', '+messages-send',
      '--as', 'bot'
    ];
    if (activeChatId) {
      args.push('--chat-id', activeChatId);
    } else {
      args.push('--user-id', PATHS.FEISHU_USER_ID);
    }
    args.push('--content', contentJson);
    log(`[sendFeishuReply] 路由目标: ${activeChatId ? 'chat_id=' + activeChatId.substring(0, 12) + '...' : 'user_id=' + (PATHS.FEISHU_USER_ID || '').substring(0, 10) + '...'}`);

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
  outputChannel = vscode.window.createOutputChannel('Feishu Trae Agent Bridge');

  log('========================================');
  log('Feishu Trae Agent Bridge 扩展已激活');
  log(`版本: 0.1.8 (会话复用修复：确认落点 + 失败回退当前面板；无回复自动重试最多 10 次)`);
  log(`激活时间: ${new Date().toISOString()}`);
  log(`lark-cli: ${PATHS.LARK_CLI || '(未找到)'}`);
  log(`工作目录: ${PATHS.WORK_DIR}`);
  log('========================================');
  log('');

  // 恢复持久化的 session 状态
  loadSessionState();

  log('');
  log('可用命令:');
  log('  - Feishu Trae Agent Bridge: Health Check (健康检查)');
  log('  - Feishu Trae Agent Bridge: Test Chat Send (Clipboard Hack)');
  log('  - Feishu Trae Agent Bridge: Test Chat Send (icube Native API) ← 推荐');
  log('  - Feishu Trae Agent Bridge: Probe APIs (探索可用接口)');
  log('  - Feishu Trae Agent Bridge: Probe Feishu Bridge (探测原生飞书桥)');
  log('  - Feishu Trae Agent Bridge: Start Full Bridge (启动完整飞书桥接) ← 新');
  log('  - Feishu Trae Agent Bridge: Stop Full Bridge (停止飞书桥接) ← 新');
  log('  - Feishu Trae Agent Bridge: Reset Feishu Session (重置飞书持久会话) ← v0.1.0+');
  log('');
  log('飞书指令: /新对话 或 /reset 可在飞书中重置会话');
  log('');
  log('通过 Ctrl+Shift+P 搜索 "Feishu Trae Agent Bridge" 调用');
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
    vscode.window.showInformationMessage('Feishu Trae Agent Bridge: 飞书 session 已重置');
  });

  // 网关命令：查看/启停适配器（生命周期可独立控制，互不影响）
  const gwListCmd = vscode.commands.registerCommand('xiaot1.bridge.gateway.list', () => {
    const items = listAdapters();
    log(`[gateway] 适配器列表: ${JSON.stringify(items)}`);
    vscode.window.showInformationMessage(`Gateway 适配器: ${items.map((a) => `${a.id}(${a.running ? '运行中' : '已停止'})`).join(', ') || '(无)'}`);
  });
  const gwStartAllCmd = vscode.commands.registerCommand('xiaot1.bridge.gateway.startAll', async () => {
    await startAllAdapters();
    log(`[gateway] startAll 完成: ${JSON.stringify(listAdapters())}`);
    vscode.window.showInformationMessage('Gateway: 全部适配器已启动');
  });
  const gwStopAllCmd = vscode.commands.registerCommand('xiaot1.bridge.gateway.stopAll', async () => {
    await stopAllAdapters();
    log(`[gateway] stopAll 完成: ${JSON.stringify(listAdapters())}`);
    vscode.window.showInformationMessage('Gateway: 全部适配器已停止');
  });
  const gwToggleCmd = vscode.commands.registerCommand('xiaot1.bridge.gateway.toggle', async () => {
    const items = listAdapters();
    if (items.length === 0) { vscode.window.showWarningMessage('Gateway: 无适配器'); return; }
    const pick = await vscode.window.showQuickPick(
      items.map((a) => ({ label: a.id, description: a.running ? '运行中' : '已停止' })),
      { placeHolder: '选择要切换启停的适配器' }
    );
    if (!pick) return;
    const cur = listAdapters().find((a) => a.id === pick.label);
    if (cur && cur.running) await stopAdapter(cur.id); else await startAdapter(cur.id);
    const now = listAdapters().find((a) => a.id === cur.id);
    log(`[gateway] toggle ${cur.id} → ${now && now.running ? '运行中' : '已停止'}`);
    vscode.window.showInformationMessage(`Gateway: ${cur.id} → ${now && now.running ? '运行中' : '已停止'}`);
  });

  context.subscriptions.push(healthCmd, testCmd, testIcubeCmd, probeCmd, probeFeishuCmd, startCmd, stopCmd, resetSessionCmd,
    gwListCmd, gwStartAllCmd, gwStopAllCmd, gwToggleCmd);

  // 网关：把飞书逻辑原位注册成内置 adapter（传输逻辑不搬家，仅包一层描述符）
  registerAdapter(feishuAdapter);
  log(`[gateway] 已注册适配器: ${listAdapters().map((a) => a.id).join(', ')}`);

  // 保活：激活时经网关自动启动桥接，保证飞书消息随时可达（startAdapter 内含 try/catch 隔离）
  log('[保活] 扩展已激活，经网关自动启动飞书桥接...');
  startAdapter('feishu')
    .then((ok) => { if (!ok) log('[保活] 飞书适配器启动失败，详见上文 gateway 日志'); })
    .catch((e) => log(`[保活] 自动启动异常: ${e.message}`));

  // 暴露给其他扩展的公开 API：VS Code 的 extension.exports 取 activate() 的返回值（不是 module.exports）
  return {
    registerInboundInterceptor,
    registerAdapter,
    registerOutboundHook,
    listAdapters,
    startAdapter,
    stopAdapter,
    startAllAdapters,
    stopAllAdapters
  };
}

function deactivate() {
  // 标记手动停止并清理定时器，避免扩展卸载后残留重启
  bridgeManuallyStopped = true;
  if (bridgeRestartTimer) {
    clearTimeout(bridgeRestartTimer);
    bridgeRestartTimer = null;
  }
  if (bridgeProcess) {
    try { bridgeProcess.kill(); } catch (e) { /* 忽略 */ }
    bridgeProcess = null;
  }
  // 持久化 session 状态，重启后恢复
  saveSessionState();
  if (outputChannel) {
    log('Feishu Trae Agent Bridge 扩展已停用 (session 状态已持久化)');
  }
}

module.exports = {
  activate,
  deactivate,
  // 网关公开 API（消费方应经 extension.exports 取 activate() 返回值；此处导出便于本地调试）
  registerInboundInterceptor,
  registerAdapter,
  registerOutboundHook,
  listAdapters,
  startAdapter,
  stopAdapter,
  startAllAdapters,
  stopAllAdapters
};
