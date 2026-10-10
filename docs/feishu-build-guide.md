# Trae CN 飞书桥接构建指南

> 基于 2026-08-03 ~ 2026-08-05 探索与实现过程整理
> 状态：端到端链路已打通 ✅（v0.1.2 保活自动重启 + 孤儿进程清理，只要 Trae 打开飞书即持续在线；飞书↔Trae Agent 双向通信已验证）
> 演进规划见 [gateway-architecture.md](./gateway-architecture.md)：把飞书桥演进为「外部接入 + 增强」网关（P1 起基座暴露通用扩展点 `registerInboundInterceptor`，增强独立成扩展）。

---

## 〇、探索历史时间线

### Phase 1：外部浏览器方案（2026-08-03）❌ 全部失败

| 尝试 | 结果 | 原因 |
|------|------|------|
| browser_use 操控 Trae webview | 失败 | browser_use 操作独立浏览器，无法跨越到 `vscode-webview://` 协议；`browser_evaluate` 返回 null；无 `connectOverCDP` 工具；chat 无 HTTP API |
| Chrome `--remote-debugging-port` | 失败 | Trae CN 在代码层面主动禁用了 Electron CDP |
| CDP 协议连接 | 失败 | Trae CN 主动禁用，无法通过任何方式获取 CDP 端口 |

**结论**：Trae CN 架构是封闭的，外部浏览器/CDP 方案完全不可行，必须使用 Trae 内部 API。

### Phase 2：VSCode 扩展 MVP（2026-08-04）✅ 打通发送链路

| 步骤 | 操作 | 结果 |
|------|------|------|
| 创建扩展 | `feishu-trae-agent-bridge` (v0.0.1) | 含 5 个命令 |
| 健康检查 | 探测 chat 相关命令 | `workbench.action.chat.toggle` 和 `workbench.action.chat.clear` 不存在；`workbench.action.chat.submit` 存在 |
| icube 原生 API 发送 | `icube.chat.sendToAgentNonBlocking` | ✅ 成功发送到 chat，返回 `{sessionId}` |
| 创建独立 session | `newSession: true` | ✅ 避免干扰当前对话 |
| 轮询状态 | `icube.chat.getSessionRunningStatus` | ✅ 返回 `WaitingInput` 表示回复完成 |
| 读取回复 | `icube.chat.copyLastTurnDebugInfo` | ❌ "not supported for current user" |

**已验证**：发送 → 轮询 → Agent 回复的完整链路打通。唯一缺口是无法读取回复内容。

### Phase 3：探索回复读取方案（2026-08-05）❌ 多数失败

| 尝试 | 结果 | 原因 |
|------|------|------|
| 枚举 icube.* 命令（411 个） | 发现 `icube.chat.*` 仅 10 个，无读取 API | 全是控制/状态类命令 |
| 读取 SQLite `database.db` | SQLCipher 加密 | 文件头 `B4 D2 6E 82`，无密钥 |
| 读取 `snapshot/<id>/v2/.git` | 内容不符 | 文件系统 diff 快照（undo 用），非 chat 文本 |
| 读取 `sandbox/restricted/*.json` | 内容不符 | 文件访问日志，非 chat 内容 |
| `vscode.window.tabGroups` | 无 chat 内容 | Chat 是 panel view，不是 editor tab |
| `icube.webview.sendCommand` | **卡死扩展宿主** | 同步阻塞事件循环，`Promise.race`/`withTimeout` 无法恢复 |
| DevTools DOM 读取 | 待验证 | `openDeveloperTools` 可用，但 Trae CN 可能禁用 CDP |
| `icube.common.commands.tooling.*` (60+ 命令) | 发现 `readFile`/`writeFile` | 可用于 sideband 文件协议 |

### Phase 4：发现原生飞书桥 + lark-cli（2026-08-05）✅ 重大突破 → ❌ 原生桥失败 → ✅ lark-cli 成功

| 步骤 | 操作 | 结果 |
|------|------|------|
| 枚举 `icube.imBridge.*` 命令 | 发现 `icube.imBridge.feishu.*` 共 25 个命令 | 含 login/reply/streamStart 等 |
| 检查桥状态 | `getEnabled()` 返回 `false` | 桥默认关闭 |
| 获取配置路径 | `getChannelConfigPath` 返回 `{dir, file, userId}` 对象 | 文件 `channel_config.json` 不存在 |
| 写入配置 | 用真实凭据创建 `channel_config.json` | 含 appId/appSecret/brand/enabled |
| 启用桥 | `setEnabled(true)` | ❌ 返回 undefined，getEnabled() 始终 false |
| 登录飞书 | `feishu.login()` 各种参数组合 | ❌ 全部返回 undefined，checkBound 始终 false |
| 发现 lark-cli | 内置 `@trae-plugins/lark` 插件 CLI | ✅ 已预装，OAuth 已配置 |
| 切换 appId | lark-cli config init + OAuth Device Flow | ✅ 用户机器人 APP_ID_PLACEHOLDER 认证成功 |
| 发送消息 | lark-cli im +messages-send --as bot | ✅ 成功发送 P2P 消息 |
| 读取消息 | lark-cli im +chat-messages-list --as user | ✅ 成功读取 P2P 消息 |
| 事件监听 | lark-cli event consume im.message.receive_v1 | ⚠️ 初始失败（WSL 冲突），解决后成功 |
| 停止 WSL 服务 | kill ws_client.py 进程 | ✅ Windows lark-cli 接管事件监听 |

### Phase 5：完整链路实现与迭代（2026-08-05 下午）✅ 端到端打通

| 版本 | 变更 | 测试结果 |
|------|------|----------|
| v0.0.7 | 完整链路首次实现（sideband 文件协议，30s超时轮询） | ❌ sideband 文件30s超时未出现（Agent 未及时写入） |
| v0.0.8 | 并发轮询：先等 Agent 状态 WaitingInput，再轮询 sideband 文件 | ✅ "飞书好了吗4" 端到端成功，67s 回复 |
| v0.0.9 | fs.watch 零延迟 + 自适应轮询 + 双重读取校验 | ✅ "飞书好了吗5" 端到端成功，10s 回复 |
| v0.0.10 | 超时保护：maxWait 300s→600s + 30s 宽限期重试 + 立即首次检查 | ⚠️ 复杂任务触发超时恢复机制，简单任务仍秒级回复 |
| v0.1.0 | 持久 session 复用：不再每条消息新建会话，飞书消息共享同一 session 保持上下文 | 🔄 首条消息创建 session，后续复用；支持 `/新对话` 重置 |
| v0.1.1 | Session 智能复用策略 D + 全链路详细日志 + PERF 计时标签 | ✅ Session 丢失时自动复用当前 chat 面板会话；7 阶段时间戳覆盖所有退出路径；全链路结构化日志便于排查 |
| v0.1.4 | 网关概念落地（P2）：adapter 注册表 + `OutboundHook` + 每适配器错误隔离，飞书逻辑原位注册为内置 adapter | ✅ TC-17 运行时验证；详见 gateway-architecture.md |
| v0.1.5 | 固定话题：飞书会话按 `chat_id` 固定映射到一个 Trae session；修复 `/new` 检测（比对原始输入）与「重置后被复用策略抢回」两个 latent bug | 🔄 待运行时验证（TC-25~TC-28） |
| v0.1.6 | 会话复用修复：去掉「策略 A 三格式盲发 + 策略 B 复用当前面板」的重复投递与串场，改为存档优先、全程单次发送、回读确认实际落点；超时阈值 30 分钟 → 12 小时 | ⚠️ 运行时发现新的「超时无回复」：后台定向发送不被触发（见 v0.1.7） |
| v0.1.7 | 定位「超时无回复」根因：`sendToAgentNonBlocking` 只在当前聚焦会话触发 agent，发往后台存档会话返回无 `sessionId`、消息被静默丢弃。改为「确认落点才复用，否则回退当前聚焦面板重发」 | 🔄 待运行时验证（TC-25~TC-28） |

**关键实测数据**（bridge.log）：

v0.0.8 首次端到端成功：
```
[15:17:42] [收到] 飞书消息: "飞书好了吗4" (event: 28c511f8...)
[15:17:42] [发送] OK, sessionId: 6a72e3968129
[15:17:43] [状态] WaitingInput (1s, 等待文件...)
[15:18:50] [收到] Agent 回复 (42 字符): 飞书桥已就绪 ✅ ...
[15:18:51] [回复] 已发送: ok=true
```

v0.0.9 优化后：
```
[15:31:28] [收到] 飞书消息: "飞书好了吗5" (event: 6598544e...)
[15:31:28] [发送] OK, sessionId: 6a72e6d08129
[15:31:29] [状态] WaitingInput (0s)
[15:31:39] [轮询] 收到 Agent 回复 (6 字符, 10s): 收到测试消息...
[15:31:40] [回复] 已发送: ok=true
```

v0.0.10 超时触发后恢复机制（复杂任务超 300s 未完成）：
```
[15:32:13] [收到] 飞书消息: "你要先整体整理下你实现飞书的过程..." (event: 76f76833...)
[15:32:13] [发送] OK, sessionId: 6a72e6fd8129
[15:32:13] [状态] WaitingInput (0s)
[15:37:13] [TIMEOUT] 300秒内未收到 sideband 文件     ← v0.0.9 的 5 分钟超时
[15:37:14] [回复] 已发送: 超时通知
```
> **根因**：Agent 处理"整理文档"复杂任务时，虽然状态已 WaitingInput，但 Write 工具写入 sideband 文件耗时超过 300s 阈值。v0.0.10 将 maxWait 提升到 600s 并增加 30s 宽限期重试。

### 探索过程中的关键教训

1. **Trae CN 是封闭架构**：外部浏览器/CDP 方案完全不可行
2. **`icube.webview.sendCommand` 是陷阱**：同步阻塞事件循环，一旦调用必须重载窗口
3. **`copyLastTurnDebugInfo` 权限门控**：普通用户无法使用，无法直接读取 Trae Agent 回复
4. **原生飞书桥默认关闭**：必须手动创建 `channel_config.json` 并调用 `setEnabled(true)` + `login()`，但即使配置写入也无法绑定
5. **lark-cli 已预装**：Trae 内置了完整的飞书 CLI 工具，OAuth 认证已配置，是最可行的路径
6. **Bridge 扩展缓存问题**：新增命令后必须 `Developer: Reload Window` 或完全重启 Trae 才能生效；V8 bytecode 缓存需删除 `CachedData` 目录
7. **Sideband 文件协议是关键突破**：因无法直接读取 Trae Agent 回复，通过在消息中附加写入文件的指令，Agent 用 Write 工具写入 sideband 文件，Bridge 读取后发回飞书
8. **WSL 冲突**：WSL 上 ws_client.py 占用同一 appId 的事件总线，必须停止后 Windows lark-cli 才能接收事件
9. **`--profile` 全局参数**：lark-cli 支持 `--profile <name>` 切换命名 profile，避免修改默认 app（Trae 内置插件依赖默认 app）

---

## 一、架构总览

Trae CN 有三条飞书集成路径，**当前采用路径 B+C 混合方案**：

| 路径 | 方式 | 适用场景 | 状态 |
|------|------|----------|------|
| **A: 原生桥** | `icube.imBridge.feishu.*` 内部命令 | 零代码集成，Trae 内部处理飞书通信 | ❌ 已放弃（login 无法绑定） |
| **B: lark-cli** | 内置 `@trae-plugins/lark` 插件 CLI | 飞书 API 调用（发送/读取/事件监听） | ✅ 已采用，核心引擎 |
| **C: 自建扩展** | VSCode 扩展 + sideband 文件协议 | 绕过 Trae 内部状态读取限制 | ✅ 已采用，回复读取方案 |

### 当前实际架构（v0.1.2）

```
┌─────────────┐    飞书消息     ┌──────────────┐
│  飞书用户    │ ─────────────→ │  飞书服务器    │
└─────────────┘                 └──────┬───────┘
                                       │ im.message.receive_v1
                                       ↓
┌──────────────────────────────────────────────────────────────┐
│  Feishu Trae Agent Bridge 扩展 (extension.js v0.1.2)        │
│                                                              │
│  ① lark-cli event consume (子进程, --profile xiaot1)          │
│     ← [保活] 激活时自动启动 + 启动前清理孤儿进程              │
│     ← [保活] 退出自动重启（指数退避 3s→60s，上限 60s）        │
│     → stdout JSON 事件 → enqueueEvent → 去重 → 消息队列       │
│     → [PERF] T0 事件接收时间戳 + 日志                        │
│                                                              │
│  ② handleFeishuEvent:                                        │
│     → [PERF] T1 开始处理时间戳                               │
│     → 按 event.chat_id 载入该对话专属 session                │
│     → Session 复用策略（forceNew 时跳过 A/B）:               │
│       策略 A: 该对话已保存 sessionId → 参数复用              │
│       策略 B/D: A 失败 → 复用当前面板会话（不新建）          │
│       强制新建: /new 或超时后首条 → 跳过复用直接新建         │
│     → [PERF] T2 发送开始 → T3 发送完成                       │
│     → icube.chat.sendToAgentNonBlocking (sessionId 复用)     │
│     → 消息格式: "[飞书消息] 用户说：xxx\n[系统指令] 写入文件: │
│        replies/<msgId>.txt"                                  │
│     → [PERF] T4 开始等待                                    │
│     → 立即首次检查 sideband 文件                             │
│     → fs.watch + 自适应轮询读取 sideband 文件 (maxWait=600s) │
│     → [PERF] T5 sideband 文件检测到                         │
│     → 双重读取校验（防半截内容）                              │
│     → 超时保护：30s 宽限期重试 + RECOVERY 恢复               │
│     → Session 重置：/new 指令 + 30min 超时                   │
│                                                              │
│  ③ lark-cli im +messages-send --as bot --user-id <id>        │
│     → [PERF] T7 飞书回复完成                                │
│     → [PERF-END] 7 阶段耗时分析报告                         │
│                                                              │
│  全链路日志标签:                                             │
│     [lark-cli] [enqueueEvent] [processQueue]                │
│     [handleFeishuEvent] [Session] [等待] [轮询] [RECOVERY]  │
│     [sendFeishuReply] [PERF] [PERF-END]                     │
│                                                              │
└──────────────────────────────────────────────────────────────┘
                                       ↓
┌─────────────┐    飞书回复     ┌──────────────┐
│  飞书用户    │ ←───────────── │  飞书服务器    │
└─────────────┘                 └──────────────┘
```

---

## 二、路径 A：原生桥（`icube.imBridge.feishu.*`）

### 2.1 发现过程

1. 枚举 `icube.*` 命令（411 个），发现 `icube.imBridge.feishu.*` 共 25 个命令
2. 初始状态：`getEnabled()` 返回 `false`，所有命令返回 `undefined`
3. `getChannelConfigPath` 返回配置路径对象 `{dir, file, userId}`，但文件不存在
4. 手动写入配置文件后，`setEnabled(true)` + `login()` 激活桥

### 2.2 配置步骤

#### Step 1：获取配置文件路径

```javascript
const r = await vscode.commands.executeCommand('icube.imBridge.getChannelConfigPath');
// 返回: {
//   dir: "file:///c%3A/Users/yuanw/.trae-cn/2807473419332203/3d00464aa3cb7b8c2deec222ddf1c7d5",
//   file: "file:///c%3A/Users/yuanw/.trae-cn/2807473419332203/3d00464aa3cb7b8c2deec222ddf1c7d5/channel_config.json",
//   userId: "2807473419332203"
// }
// 注意：文件默认不存在，需要手动创建
```

#### Step 2：解析路径并写入配置

```javascript
// 解析 URI 路径
const uri = decodeURIComponent(r.file);
const fsPath = uri.replace(/^file:\/\//, '').replace(/^\//, '');
// fsPath = "c:/Users/yuanw/.trae-cn/2807473419332203/3d00464aa3cb7b8c2deec222ddf1c7d5/channel_config.json"

// 写入配置
const config = {
  appId: "APP_ID_PLACEHOLDER",     // 飞书机器人 app_id
  appSecret: "APP_SECRET_PLACEHOLDER",  // 飞书机器人 app_secret
  brand: "feishu",
  enabled: true
};
require('fs').writeFileSync(fsPath, JSON.stringify(config, null, 2));
```

#### Step 3：启用桥并登录

```javascript
// 启用桥
await vscode.commands.executeCommand('icube.imBridge.setEnabled', true);

// 登录飞书
await vscode.commands.executeCommand('icube.imBridge.feishu.login');

// 验证绑定状态
const bound = await vscode.commands.executeCommand('icube.imBridge.feishu.checkBound');
// bound === { bound: true } 表示桥已就绪
```

#### Step 4：接收飞书消息

```javascript
const events = await vscode.commands.executeCommand('icube.imBridge.feishu.getEvents');
// 返回飞书事件数组（消息、事件等）
// 轮询此接口接收飞书入站消息
```

#### Step 5：发送回复到飞书

```javascript
// 简单回复
await vscode.commands.executeCommand('icube.imBridge.feishu.reply', {
  messageId: "msg_xxx",    // 从 getEvents 获取
  text: "回复文本"
});

// 流式回复（推荐用于 Agent 输出）
await vscode.commands.executeCommand('icube.imBridge.feishu.streamStart', {
  sessionId: "session_xxx",
  text: "正在回复..."
});
await vscode.commands.executeCommand('icube.imBridge.feishu.streamUpdate', {
  text: " 增量内容"
});
await vscode.commands.executeCommand('icube.imBridge.feishu.streamEnd', {
  text: "回复完成"
});
```

### 2.3 全部 25 个桥接命令

```
icube.imBridge.feishu.login
icube.imBridge.feishu.checkBound
icube.imBridge.feishu.getEvents
icube.imBridge.feishu.reply
icube.imBridge.feishu.streamStart
icube.imBridge.feishu.streamUpdate
icube.imBridge.feishu.streamEnd
icube.imBridge.feishu.getSessionBotBinding
icube.imBridge.feishu.listSessionBotBindings
icube.imBridge.feishu.resolveSessionByAppId
icube.imBridge.feishu.uploadFile
icube.imBridge.feishu.updateReaction
icube.imBridge.feishu.pause
icube.imBridge.feishu.resume
icube.imBridge.feishu.stop
icube.imBridge.feishu.unbind
icube.imBridge.feishu.sessionBind.confirm
icube.imBridge.feishu.sessionBind.cancel
icube.imBridge.feishu.sessionBind.login
icube.imBridge.feishu.sessionBind.getEvents
icube.imBridge.feishu.sessionBind.unbind
icube.imBridge.feishu.getSessionGroupMentionPolicy
icube.imBridge.feishu.setSessionGroupMentionPolicy
icube.imBridge.feishu.getWorkspaceGroupMentionPolicy
icube.imBridge.feishu.setWorkspaceGroupMentionPolicy
```

### 2.4 辅助命令

```
icube.imBridge.getChannelConfigPath   // 获取配置文件路径
icube.imBridge.getEnabled              // 检查桥是否启用
icube.imBridge.setEnabled              // 启用/禁用桥
icube.imBridge.wx.*                   // 微信桥（10 个命令）
```

---

## 三、路径 B：lark-cli（内置 CLI 工具）

### 3.1 基本信息

- **位置**: `C:\Users\{username}\.trae-cn\plugins\trae-remote-official\lark\1.0.3\bin\lark-cli.exe`
- **版本**: 1.0.3
- **认证**: OAuth（Device Flow）
- **已配置 appId**: `OTHER_APP_ID_PLACEHOLDER`
- **配置文件**: `C:\Users\{username}\.lark-cli\config.json`

### 3.2 常用命令

```powershell
# 查看认证状态
& "lark-cli.exe" auth status

# 查看当前配置
& "lark-cli.exe" config show

# 接收消息（长轮询）
& "lark-cli.exe" im messages list --chat-id "oc_xxx"

# 发送消息
& "lark-cli.exe" im messages send --chat-id "oc_xxx" --msg-type "text" --text '{"text":"hello"}'

# 查看事件总线日志
# 路径: C:\Users\{username}\.lark-cli\events\{appId}\bus.log
```

### 3.5 原生桥 vs lark-cli：最终结论

**原生飞书桥（icube.imBridge.*）** 这条路走不通：
- `feishu.login()` 所有参数组合返回 `undefined`
- `setEnabled(true)` 返回 `undefined`，`getEnabled()` 始终为 `false`
- `checkBound` 始终返回 `{bound: false}`
- `getEvents` 返回错误："Missing required IM Bridge config URLs"
- **根因**：飞书桥使用 OAuth 认证（`connector.json` 中 `auth_policy: "ON_INVOKE"`），需要先完成 OAuth 流程

**lark-cli 完全可用** ✅：
- 已认证状态：Bot `ready`，User `needs_refresh`（自动刷新）
- 可发送消息：`im +messages-send --as user --chat-id <id> --text "msg"`
- 可读取消息：`im +chat-messages-list --as user --chat-id <id>`
- 可列出聊天：`im +chat-list --as user --types p2p,group`
- 支持 OAuth Device Flow 认证

### 3.5.1 lark-cli 关键命令

```bash
# 认证状态
lark-cli auth status

# 列出聊天
lark-cli im +chat-list --as user --types p2p,group --format json

# 发送消息
lark-cli im +messages-send --as user --chat-id <chat_id> --text "消息内容"

# 读取消息
lark-cli im +chat-messages-list --as user --chat-id <chat_id> --page-size 10

# OAuth 登录（切换 appId）
lark-cli auth login --no-wait --domain im
```

### 3.5.1b lark-cli 事件监听系统（长连接实时接收）✅

**重大发现**：lark-cli 内置完整的事件总线系统，支持飞书 `im.message.receive_v1` 事件长连接实时接收，无需轮询。

#### 事件总线状态

```bash
lark-cli event status
```

输出示例（事件总线已在后台运行 21 小时）：
```
── OTHER_APP_ID_PLACEHOLDER ──
  Bus:              running (PID 2356, uptime 21h11m45s)
  Active consumers: 1

  CONSUMER   EVENT KEY              SUB  RECEIVED  DROPPED
  pid=44068  im.message.receive_v1  -    0         0
```

#### 事件 consume 命令

```bash
# 启动事件消费（实时流式输出，NDJSON 格式）
lark-cli event consume im.message.receive_v1 --as bot --timeout 60s

# 参数说明：
#   --as string           身份类型: user | bot | auto
#   --jq string           JQ 表达式过滤输出
#   --max-events int      接收 N 个事件后退出（0=无限）
#   --output-dir string   将事件写入目录（每个事件一个文件）
#   --timeout duration    超时退出（如 30s, 2m），0=永不超时
#   --quiet               静默模式
```

#### 事件 schema（im.message.receive_v1）

```bash
lark-cli event schema im.message.receive_v1
```

输出字段：
| 字段 | 类型 | 说明 |
|------|------|------|
| `chat_id` | string | 群聊 ID（oc_ 前缀） |
| `chat_type` | string | p2p 或 group |
| `content` | string | 消息内容（已渲染的人类可读文本） |
| `create_time` | string | 创建时间（ms 时间戳字符串） |
| `event_id` | string | 全局唯一事件 ID（可用于去重） |

**所需权限**：
- Scope: `im:message.p2p_msg:readonly`
- Console Event: `im.message.receive_v1`（必须在开发者后台启用）

#### 全部可用事件

```bash
lark-cli event list
```

关键事件：
- `im.message.receive_v1` - 接收 IM 消息 ✅ 核心事件
- `im.chat.member.bot.added_v1` - 机器人被加入群
- `im.chat.member.bot.deleted_v1` - 机器人被移出群
- `im.message.message_read_v1` - 用户已读消息
- `im.message.reaction.created_v1` - 表情回应
- `card.action.trigger` - 卡片交互（按钮点击等）

#### 事件总线管理命令

```bash
lark-cli event list                  # 列出所有可用事件
lark-cli event schema <EventKey>     # 查看事件 schema
lark-cli event status                # 查看事件总线状态
lark-cli event stop                  # 停止事件总线守护进程
lark-cli event consume <EventKey>    # 开始消费事件
```

#### 事件总线日志路径

```
C:\Users\{username}\.lark-cli\events\{appId}\bus.log
```

日志记录了长连接重连机制、心跳保活等后台运行状态。

#### 事件总线保活机制（bus.log 分析）

bus.log 显示 lark-cli 使用 **30 秒 consumer 轮询周期**维持长连接：

```
2026/08/05 12:31:48 Consumer connected: pid=4460 key="im.message.receive_v1" first=true
2026/08/05 12:32:18 Consumer disconnected: pid=4460 (remaining=0)   ← 30秒后断开
2026/08/05 12:32:20 Consumer connected: pid=3276 key="im.message.receive_v1" first=true  ← 2秒后重连
2026/08/05 12:32:50 Consumer disconnected: pid=3276 (remaining=0)
...
```

**机制说明**：
- 每个 consumer 生存周期 30 秒，到期后断开
- 断开后 2 秒内启动新 consumer 重连
- `first=true` 表示该 appId 的首个 consumer，`first=false` 表示后续重连
- `remaining=N` 表示断开时还有 N 个 consumer 在线
- 此机制保证长连接稳定，避免单连接超时断开

#### consume 实测结果（2026-08-05）

```bash
lark-cli event consume im.message.receive_v1 --as bot --timeout 60s
```

日志输出：
```
[event] consuming as OTHER_APP_ID_PLACEHOLDER (OTHER_APP_ID_PLACEHOLDER)
[event] listening for events (key=im.message.receive_v1); will exit after 1m0s timeout
[event] to stop gracefully: send SIGTERM (kill <pid>). Avoid kill -9
[event] ready event_key=im.message.receive_v1
[event] exited — received 0 event(s) in 1m0s (reason: timeout)
```

**结果**：60 秒内收到 0 个事件。

**原因分析**：
1. 当前 appId `OTHER_APP_ID_PLACEHOLDER` 是 lark-cli 自带机器人，用户未与其互动
2. 机器人需要在飞书开发者后台启用 `im.message.receive_v1` 事件订阅
3. 机器人需要被用户添加为好友或加入群聊

**结论**：lark-cli 事件消费机制工作正常（consume 命令成功启动、监听、超时退出），但需要切换到用户自己的机器人 appId `APP_ID_PLACEHOLDER` 才能接收到实际消息。

### 3.5.1c lark-cli 认证状态详情（2026-08-05 验证）

当前 appId `OTHER_APP_ID_PLACEHOLDER`（lark-cli 自带）认证状态：

| 身份 | 状态 | 说明 |
|------|------|------|
| bot | ready ✅ | 可用 |
| user | ready ✅ | openId: `USER_OPEN_ID_PLACEHOLDER`，用户名: （用户名） |
| tokenStatus | valid | 用户 token 有效 |
| identity | user | 默认身份为 user |
| expiresAt | 2026-08-05T14:25:31+08:00 | token 过期时间（自动刷新） |
| refreshExpiresAt | 2026-08-12T12:25:31+08:00 | refresh token 过期时间 |
| grantedAt | 2026-08-04T13:42:20+08:00 | 授权时间 |

**关键权限 scope**（部分）：
- `im:message` - 发送消息
- `im:message:readonly` - 读取消息
- `im:message.p2p_msg:get_as_user` - 以用户身份读取 P2P 消息
- `im:message.group_msg:get_as_user` - 以用户身份读取群消息
- `im:chat:read` - 读取群信息
- `im:chat.members:read` - 读取群成员
- `im:chat.members:write_only` - 管理群成员

**结论**：user 身份完全可用，可发送/读取消息，可监听事件。bot 身份 ready 但受限于机器人是否加入群聊。

### 3.5.1d 切换 appId 到用户机器人（2026-08-05）

#### 步骤 1：用 config init 添加新 app 配置

```powershell
# 用 --name 创建命名 profile（追加，不覆盖现有配置）
"APP_SECRET_PLACEHOLDER" | & "lark-cli.exe" config init `
  --app-id "APP_ID_PLACEHOLDER" `
  --brand feishu `
  --app-secret-stdin `
  --name "xiaot1"
```

输出：
```json
{
  "appId": "APP_ID_PLACEHOLDER",
  "appSecret": "****",
  "brand": "feishu"
}
OK: Configuration saved to C:\Users\{username}\.lark-cli\config.json
```

#### 步骤 2：修改 config.json 切换默认 app

`lark-cli` 没有提供 `config use` 或 `--profile` 参数切换默认 profile。解决方式：直接编辑 `C:\Users\{username}\.lark-cli\config.json`，把目标 app 移到 `apps` 数组第一位（无 `name` 字段的为默认 app）。

修改后的 config.json 结构：
```json
{
  "apps": [
    {
      "appId": "APP_ID_PLACEHOLDER",          ← 默认 app（无 name 字段）
      "appSecret": { "source": "keychain", "id": "appsecret:APP_ID_PLACEHOLDER" },
      "brand": "feishu",
      "users": []                                ← 待登录
    },
    {
      "name": "lark-cli-default",                ← 原 lark-cli 自带 app（加 name 保留）
      "appId": "OTHER_APP_ID_PLACEHOLDER",
      "appSecret": { "source": "keychain", "id": "appsecret:OTHER_APP_ID_PLACEHOLDER" },
      "brand": "feishu",
      "users": [{ "userOpenId": "USER_OPEN_ID_PLACEHOLDER", "userName": "（用户名）" }]
    }
  ]
}
```

**验证切换成功**：
```bash
lark-cli config show
# 输出: appId=APP_ID_PLACEHOLDER, profile=APP_ID_PLACEHOLDER, users=(no logged-in users)
```

#### 步骤 3：OAuth Device Flow 登录授权

```powershell
# 启动 Device Flow，获取验证 URL（不阻塞）
& "lark-cli.exe" auth login --no-wait --json --domain im
```

输出：
```json
{
  "device_code": "OQ8xQHj6JXXoZnLGbTipfMadMyHShJLJ...(省略)",
  "expires_in": 600,
  "verification_url": "https://accounts.feishu.cn/oauth/v1/device/verify?flow_id=...&user_code=XGKD-9BJJ"
}
```

**生成 QR 码**（必须用相对路径）：
```powershell
cd "C:\Users\{username}\.lark-cli"
& "lark-cli.exe" auth qrcode --output "auth_qr.png" "<verification_url>"
# 输出: {"file_path":"C:\\Users\\yuanw\\.lark-cli\\auth_qr.png","ok":true}
```

**用户授权流程**：
1. 用户用飞书 App 扫描 QR 码，或浏览器打开 verification_url
2. 输入 user_code（如有提示）
3. 在飞书中确认授权
4. 通知 Agent 已完成

**Agent 完成登录**：
```powershell
& "lark-cli.exe" auth login --device-code "<device_code>"
```

#### 步骤 4：验证登录状态

```powershell
& "lark-cli.exe" auth status
# 期望: bot=ready, user=ready, users=（用户名）
```

#### 关键注意事项

- **`LARKSUITE_CLI_APP_ID` 环境变量陷阱**：设置此变量会触发"外部凭据模式"，导致 `config` 命令不可用（报错 "credentials are provided externally"）。切换 appId 必须通过修改 config.json，不能用环境变量。
- **`LARKSUITE_CLI_PROFILE` 环境变量无效**：设置此变量不会切换 profile，lark-cli 仍使用 config.json 中第一个 app 作为默认。
- **`--output` 路径限制**：`auth qrcode` 的 `--output` 必须是相对路径，需先 `cd` 到目标目录。
- **appSecret 存储**：使用 keychain 存储（`source: "keychain"`），按 appId 索引，跨 profile 安全隔离。
- **Device Flow 时效**：device_code 有效期 600 秒（10分钟），过期需重新 `auth login --no-wait`。
- **config init 的 `--name` 参数**：创建命名 profile（追加到 apps 数组），不覆盖现有配置；不带 `--name` 则替换默认 app。

#### 步骤 5：发现 `--profile` 全局参数（关键突破）✅

`lark-cli` 支持 `--profile <name>` 全局参数，可以指定使用命名 profile，无需修改 config.json 默认 app。

```bash
lark-cli --profile xiaot1 auth status       # 用 xiaot1 profile 查看认证状态
lark-cli --profile xiaot1 event status      # 用 xiaot1 profile 查看事件总线
lark-cli --profile xiaot1 im +chat-list     # 用 xiaot1 profile 列出聊天
```

**正确的 config.json 结构**（默认 app + 命名 profile 共存）：
```json
{
  "apps": [
    {
      "appId": "OTHER_APP_ID_PLACEHOLDER",       ← 默认 app（无 name，Trae 内置插件用）
      "appSecret": { "source": "keychain", "id": "appsecret:OTHER_APP_ID_PLACEHOLDER" },
      "brand": "feishu",
      "users": [{ "userOpenId": "USER_OPEN_ID_PLACEHOLDER", "userName": "（用户名）" }]
    },
    {
      "name": "xiaot1",                       ← 命名 profile（lark-cli CLI 用 --profile xiaot1 指定）
      "appId": "APP_ID_PLACEHOLDER",
      "appSecret": { "source": "keychain", "id": "appsecret:APP_ID_PLACEHOLDER" },
      "brand": "feishu",
      "users": [{ "userOpenId": "ou_xxx", "userName": "（用户名）" }]
    }
  ]
}
```

**事件总线冲突解决方案**：
- 问题：如果把 APP_ID_PLACEHOLDER 设为默认 app，Trae 内置 lark 插件也会用这个 appId 连接事件总线，导致 `online_instance_cnt=1` 冲突
- 解决：保持 OTHER_APP_ID_PLACEHOLDER 为默认 app（Trae 内置插件用），lark-cli CLI 用 `--profile xiaot1` 指定用户机器人 app
- 结果：两个 app 互不干扰，事件总线正常启动

### 3.5.1e 消息收发实测（2026-08-05）✅

#### 步骤 1：bot 身份发送消息 ✅

```powershell
lark-cli --profile xiaot1 im +messages-send --as bot `
  --user-id "ou_xxx" `
  --text "feishu-trae-agent-bridge 测试：请回复任意内容"
```

输出：
```json
{
  "ok": true,
  "identity": "bot",
  "data": {
    "chat_id": "CHAT_ID_PLACEHOLDER",
    "create_time": "2026-08-05 12:50:13",
    "message_id": "om_x100b68185e911ca0dd42c966207fada"
  }
}
```

**关键发现**：
- `--user-id` 参数可指定用户 open_id（与 `--chat-id` 互斥），用于发送 P2P 消息
- bot 身份可以直接给用户发 P2P 消息
- 返回的 `chat_id` 是 P2P chat ID（CHAT_ID_PLACEHOLDER）

#### 步骤 2：user 身份读取消息 ✅

```powershell
lark-cli --profile xiaot1 im +chat-messages-list --as user `
  --chat-id "CHAT_ID_PLACEHOLDER" `
  --page-size 5
```

成功读取到消息（包括用户回复和机器人发送的）：
```json
{
  "ok": true,
  "identity": "user",
  "data": {
    "has_more": true,
    "messages": [
      {
        "content": "好了没",                        ← 用户回复
        "create_time": "2026-08-05 12:54",
        "message_id": "om_x100b68186fac0ca4b150553149a2cd9",
        "msg_type": "text",
        "sender": {
          "id": "ou_xxx",
          "name": "（用户名）",
          "sender_type": "user"
        }
      },
      {
        "content": "feishu-trae-agent-bridge 测试：请回复任意内容",  ← 机器人发送
        "create_time": "2026-08-05 12:50",
        "message_id": "om_x100b68185e911ca0dd42c966207fada",
        "sender": {
          "id": "APP_ID_PLACEHOLDER",
          "id_type": "app_id",
          "sender_type": "app"
        }
      }
    ]
  }
}
```

**关键发现**：
- user 身份可以读取 P2P chat 的所有消息（包括用户发的和机器人发的）
- 消息按时间倒序排列（最新在前）
- `sender.sender_type` 区分 `user` 和 `app`
- 可通过 `message_id` 或 `create_time` 去重和追踪新消息

#### 步骤 3：事件监听实测（未收到事件）⚠️

```powershell
lark-cli --profile xiaot1 event consume im.message.receive_v1 --as bot --timeout 90s
```

日志：
```
[event] consuming as xiaot1 (APP_ID_PLACEHOLDER)
[event] listening for events (key=im.message.receive_v1); will exit after 1m30s timeout
[event] ready event_key=im.message.receive_v1
[event] exited — received 0 event(s) in 1m29s (reason: timeout)
```

**结果**：90 秒内收到 0 事件（用户在期间发了消息，但事件未到达）。

**原因**：根据 `event schema` 提示，需要在飞书开发者后台启用 `im.message.receive_v1` 事件订阅：
> Required Console Events (must be enabled in developer console):
>   - im.message.receive_v1

**解决方案**：
1. 登录飞书开发者后台（https://open.feishu.cn）
2. 找到机器人应用 `APP_ID_PLACEHOLDER`
3. 在"事件订阅"中启用 `im.message.receive_v1`
4. 选择"长连接"方式（无需配置回调 URL）

### 3.5.1f 消息收发方案对比

| 方案 | 实时性 | 配置复杂度 | 可靠性 | 状态 |
|------|--------|-----------|--------|------|
| **事件监听**（im.message.receive_v1） | 实时 | 需后台配置 | 高 | ⚠️ 需启用事件订阅 |
| **轮询读取**（chat-messages-list） | 延迟 N 秒 | 零配置 | 高 | ✅ 已验证可用 |

**推荐方案**：
- **短期**：用轮询方案（user 身份读取 P2P chat 消息），零配置即可使用
- **长期**：启用事件订阅，实现实时接收

**轮询方案实现要点**：
1. 记录上次读取的最后一条消息 ID
2. 每 N 秒（如 3 秒）调用 `chat-messages-list` 读取新消息
3. 过滤出 `sender_type: "user"` 的消息（排除机器人自己发的）
4. 对新消息调用 Trae Agent，获取回复
5. 用 bot 身份发送回复到 P2P chat

### 3.5.1g 事件总线冲突根因：WSL 小T 占用连接（2026-08-05）✅

**问题**：Windows lark-cli 启动事件监听时报错 `online_instance_cnt=1`，提示"another event bus is already connected to this app"。

**根因**：WSL 上有小T 的飞书 WebSocket 客户端在运行，占用了同一个 appId 的事件总线连接。

#### WSL 上的飞书服务进程

```bash
$ wsl ps aux | grep -iE 'lark|feishu|xiaot1'
PID 74097  python3 -m lark_integration.ws_client   (Jul31 启动, CC1 遗留)
PID 286589 python3 /root/xiaot1/ws_client.py        (Aug03 启动, 小T 主服务)
```

#### WSL `/root/xiaot1/.env` 配置

```bash
LARK_APP_ID=APP_ID_PLACEHOLDER                    # 同一个机器人
LARK_APP_SECRET=APP_SECRET_PLACEHOLDER
LARK_AUTHORIZED_USER_ID=ou_xxx  # 同一个用户
LARK_DEFAULT_CHAT_ID=CHAT_ID_PLACEHOLDER      # 同一个 P2P chat
```

#### WSL `ws_client.py` 架构

```python
"""小T 飞书 WebSocket 长连接 — 复用 CC1 lark_integration + 调 xiaot1-cli.

架构:
    飞书消息 → wss 长连接 → on_message_receive()
            → spawn python3 /root/xiaot1/xiaot1-cli.py --message "<消息>"
            → 拿回复 → send_text() 发回飞书
"""
import lark_oapi as lark
from lark_oapi.api.im.v1 import P2ImMessageReceiveV1  # 即 im.message.receive_v1 事件
```

**关键发现**：
1. WSL 小T 已经有完整的飞书消息处理链路（WebSocket 长连接 → CLI 处理 → 回复）
2. 飞书后台**已经启用** `im.message.receive_v1` 事件订阅（WSL 小T 需要它）
3. 飞书服务器只允许一个事件总线连接，WSL 占用后 Windows 无法启动
4. WSL 小T 和 Windows lark-cli 用的是**同一个机器人、同一个用户、同一个 P2P chat**

#### 解决方案：停止 WSL 服务，Windows lark-cli 接管 ✅

**用户决策**：停止 WSL 上的 ws_client 进程，Windows lark-cli 接管事件监听。

```bash
# 停止 WSL 上的飞书服务
wsl -d Ubuntu-22.04 -- bash -c "kill 74097 286589"

# 验证进程已停止
wsl -d Ubuntu-22.04 -- bash -c "ps aux | grep -iE 'lark|feishu|xiaot1.*ws' | grep -v grep"
# 输出: No matches found（已停止）
```

#### Windows 事件监听实测成功 ✅

```powershell
lark-cli --profile xiaot1 event consume im.message.receive_v1 --as bot --timeout 120s
```

**成功收到飞书事件**（用户发消息"好了没"）：
```json
{
  "type": "im.message.receive_v1",
  "event_id": "d285723f96232de89e0c4e4ab51a8be5",
  "timestamp": "1785905966860",
  "message_id": "om_x100b68187c28ed38b4a0b96ed4dcee5",
  "create_time": "1785905966444",
  "chat_id": "CHAT_ID_PLACEHOLDER",
  "chat_type": "p2p",
  "message_type": "text",
  "sender_id": "ou_xxx",
  "content": "好了没"
}
```

**事件字段说明**：
| 字段 | 类型 | 说明 |
|------|------|------|
| `type` | string | 事件类型，固定 `im.message.receive_v1` |
| `event_id` | string | 全局唯一事件 ID，用于去重 |
| `timestamp` | string | 事件时间戳（ms） |
| `message_id` | string | 消息 ID（om_ 前缀） |
| `create_time` | string | 消息创建时间（ms） |
| `chat_id` | string | 群聊 ID（oc_ 前缀） |
| `chat_type` | string | p2p 或 group |
| `message_type` | string | 消息类型（text/image/file 等） |
| `sender_id` | string | 发送者 open_id（ou_ 前缀） |
| `content` | string | 消息内容（已渲染的人类可读文本） |

**关键结论**：
- ✅ 停止 WSL 服务后，Windows lark-cli 成功接管事件监听
- ✅ 实时接收飞书消息（无需轮询）
- ✅ 事件包含完整消息内容、发送者、chat_id
- ✅ 可通过 `event_id` 或 `message_id` 去重
- ⚠️ 注意：WSL 小T 的飞书能力已停止，如需恢复需重新启动 ws_client.py

### 3.5.2 lark-cli 配置

- **路径**: `C:\Users\{username}\.trae-cn\plugins\trae-remote-official\lark\1.0.3\bin\lark-cli.exe`
- **当前 appId**: `OTHER_APP_ID_PLACEHOLDER`（lark-cli 自带）
- **目标 appId**: `APP_ID_PLACEHOLDER`（用户的机器人）
- **OAuth 配置**: `connector.json` 中定义 `type: "oauth"`, `auth_policy: "ON_INVOKE"`
- **环境变量映射**:
  - `LARKSUITE_CLI_USER_ACCESS_TOKEN` ← `${connector.feishu.ACCESS_TOKEN}`
  - `LARKSUITE_CLI_BRAND` ← `${connector.feishu.Provider}`
  - `LARKSUITE_CLI_APP_ID` ← `${connector.feishu.CLIENT_ID}`

### 3.5.3 两套桥接系统

- **feishu.** — 飞书桥接（主用）
- **wx.** — 微信桥接（结构相同，共 12 个命令）
- 两套都支持 `sessionBind.*` 会话绑定流程

### 3.6 原生桥配置文件格式

配置文件路径：`{userDataDir}/{userId}/{hash}/channel_config.json`

**camelCase 格式（已尝试，未成功绑定）：**
```json
{
  "appId": "APP_ID_PLACEHOLDER",
  "appSecret": "APP_SECRET_PLACEHOLDER",
  "brand": "feishu",
  "enabled": true
}
```

**snake_case 格式（已尝试，未成功绑定）：**
```json
{
  "app_id": "APP_ID_PLACEHOLDER",
  "app_secret": "APP_SECRET_PLACEHOLDER",
  "brand": "feishu",
  "enabled": true
}
```

**⚠️ 两种格式均未成功绑定**，`checkBound` 始终返回 `{bound: false}`

### 3.7 已尝试的 login 参数组合

所有尝试均返回 `undefined`，且 `checkBound` 不变：

| 参数组合 | 结果 |
|----------|------|
| 无参数 | undefined |
| 字符串 | undefined |
| `{appId: "..."}` | undefined |
| `{app_id: "..."}` | undefined |
| `{appId, appSecret}` | undefined |
| `{app_id, app_secret}` | undefined |
| `{token: "..."}` | undefined |
| `{credentials: "..."}` | undefined |
| `{appId, appSecret, brand}` | undefined |
| `"appId", "appSecret"` (两参数) | undefined |

### 3.8 原生桥待解决问题

- `feishu.login()` 是否需要先通过 OAuth 获取 token？
- 是否存在 `feishu.connect` / `feishu.authorize` / `feishu.oauth` 命令？
- 配置文件是否需要额外字段（如 `tenantAccessToken`、`appToken`、`openId`）？
- 是否需要调用 `feishu.sendMessage` 或其他命令触发认证？
- `login()` 返回 `undefined` 是否代表成功？（但 `checkBound` 仍为 false）
- 是否需要在 login 前完成 OAuth 网页授权流程？

### 3.9 支持的飞书域

```
approval    attendance  base  calendar  contact  docs  drive  im
mail        minutes    note  okr    sheets   slides  task  vc  whiteboard  wiki
```

---

## 四、路径 C：自建扩展（备选）

### 4.1 已确认的死路

| 路径 | 结果 | 原因 |
|------|------|------|
| `icube.chat.getHistory` 等 | 不存在 | `icube.chat.*` 仅 10 个命令，全是控制/状态类 |
| `copyLastTurnDebugInfo` | "not supported" | 权限门控，普通用户不可用 |
| `icube.webview.sendCommand` | **卡死扩展宿主** | 同步阻塞事件循环，`Promise.race` 无法恢复 |
| SQLite `database.db` | SQLCipher 加密 | 文件头 `B4 D2 6E 82`，无密钥 |
| `tabGroups` | 无 chat 内容 | Chat 是 panel view，不是 editor tab |
| DevTools DOM 读取 | 待验证 | `openDeveloperTools` 可用，但 Trae CN 可能禁用 CDP |

### 4.2 Sideband 文件协议（推荐备选）

如果无法读取 Trae 内部状态，可采用文件中转方案：

1. Bridge 扩展发送消息时附加指令："请把回复写入 `e:\Trae\feishu-bridge\replies\<msgId>.txt`"
2. Agent（小T）在回复时用 Write 工具写入该文件
3. Bridge 轮询该文件，读到后推回飞书

**优点**：完全绕过 Trae 内部状态读取限制
**缺点**：需要 Agent 配合写文件

---

## 五、关键配置路径

| 项目 | 路径 |
|------|------|
| 原生桥配置 | `{userDataDir}/{userId}/{hash}/channel_config.json` |
| lark-cli 配置 | `C:\Users\{username}\.lark-cli\config.json` |
| lark-cli 事件总线 | `C:\Users\{username}\.lark-cli\events\{appId}\bus.log` |
| lark-cli 插件 | `C:\Users\{username}\.trae-cn\plugins\trae-remote-official\lark\1.0.3\` |
| Bridge 扩展 | `C:\Users\{username}\.trae-cn\extensions\feishu-trae-agent-bridge\` |
| Bridge 扩展源码 | `C:\Users\{username}\.trae-cn\extensions\feishu-trae-agent-bridge\extension.js` |
| sideband 回复目录 | `e:\Trae\feishu-bridge\replies\` |
| Bridge 运行日志 | `e:\Trae\feishu-bridge\bridge.log` |
| 飞书凭据（WSL） | `/root/xiaot1/.env` |
| 项目记忆 | `C:\Users\{username}\.trae-cn\memory\projects\-e-Trae--p2-89151a9e6f80569d2e16\project_memory.md` |

---

## 六、飞书机器人凭据

| 项目 | 值 | 用途 |
|------|------|------|
| 用户机器人 APP_ID | `APP_ID_PLACEHOLDER` | Bridge 使用（--profile xiaot1） |
| 用户机器人 APP_SECRET | `APP_SECRET_PLACEHOLDER` | Bridge 使用 |
| 认证用户 open_id | `ou_xxx` | （用户名） |
| 默认 P2P chat_id | `CHAT_ID_PLACEHOLDER` | 机器人↔（用户名） P2P 会话 |
| Trae 内置 appId | `OTHER_APP_ID_PLACEHOLDER` | lark-cli 默认 profile（Trae 内置插件用） |

---

## 七、已知限制

1. **`copyLastTurnDebugInfo`** 返回 "not supported for current user" — 无法从 `icube.chat.*` 读取 Agent 回复（已用 sideband 文件协议绕过）
2. **`icube.webview.sendCommand`** 卡死 — 绝不能带参数调用
3. **原生桥 `feishu.*` 命令全部返回 `undefined`** — login/reply/streamStart 等均不可用，已放弃此路径
4. **Sideband 文件协议依赖 Agent 配合** — Agent 必须执行 Write 工具写入指定文件，如果 Agent 忽略指令则回复丢失（v0.0.10 增加超时恢复机制降低丢失风险）
5. **lark-cli event consume 1 小时超时** — 到期后进程自动退出；v0.1.2 起由保活机制自动重启（退避 3s~60s），无需手动干预（重启瞬间约 3~5s 不可用）
6. **仅支持 P2P 消息** — 群聊消息暂未实现
7. **仅支持文本消息** — 图片/文件/卡片消息暂未处理
8. **硬编码单个用户** — `FEISHU_USER_ID` 固定为（用户名）的 open_id
9. **扩展缓存问题** — 修改代码后需删除 `CachedData` 目录才能加载最新代码
10. **WSL 冲突** — 如需恢复 WSL 小T 的飞书能力，需同时停用 Windows Bridge
11. **持久 session 上下文膨胀** — 长期复用会导致 Agent 上下文过长，需定期用 `/新对话` 重置

---

## 八、快速验证命令

### Bridge 扩展命令（Ctrl+Shift+P 搜索 "XiaoT1"）

| 命令 | 用途 |
|------|------|
| `XiaoT1 Bridge: Health Check` | 健康检查 |
| `XiaoT1 Bridge: Test Chat Send (icube Native API)` | 测试发送消息到 Agent |
| `XiaoT1 Bridge: Probe APIs` | 探测所有 icube.* 命令 |
| `XiaoT1 Bridge: Probe Feishu Bridge` | 探测飞书桥接口并写入配置 |
| `XiaoT1 Bridge: Start Full Bridge` | 启动完整飞书桥接 |
| `XiaoT1 Bridge: Stop Full Bridge` | 停止飞书桥接 |
| `XiaoT1 Bridge: Reset Feishu Session` | 重置飞书持久会话 |

**飞书内置指令**：直接在飞书聊天中发送 `/新对话`、`/reset`、`/new`、`/重置对话` 可重置 session

### lark-cli 命令

```powershell
# 设置 PATH（可选）
$env:PATH = "C:\Users\{username}\.trae-cn\plugins\trae-remote-official\lark\1.0.3\bin;$env:PATH"

# 认证状态
lark-cli --profile xiaot1 auth status

# 配置信息
lark-cli --profile xiaot1 config show

# 事件总线状态
lark-cli --profile xiaot1 event status

# 列出聊天
lark-cli --profile xiaot1 im +chat-list --as user --types p2p,group --format json

# 发送消息
lark-cli --profile xiaot1 im +messages-send --as bot --user-id "ou_xxx" --text "测试"

# 读取消息
lark-cli --profile xiaot1 im +chat-messages-list --as user --chat-id "CHAT_ID_PLACEHOLDER" --page-size 5
```

---

## 九、下一步

### 已完成 ✅
1. ✅ 枚举 411 个 icube.* 命令，确认无 chat 历史读取 API
2. ✅ 确认 browser_use/CDP/SQLite/tabGroups 等死路
3. ✅ 发现 `icube.imBridge.feishu.*` 原生飞书桥（25 个命令）
4. ✅ 发现内置 lark-cli CLI 工具
5. ✅ 创建 feishu-trae-agent-bridge 扩展 MVP（7 个命令）
6. ✅ 打通发送链路：sendToAgentNonBlocking → getSessionRunningStatus
7. ✅ 定位 channel_config.json 路径和格式
8. ✅ 确认原生桥使用 OAuth 认证，`feishu.login` 走不通
9. ✅ lark-cli 已认证，可发送/读取消息
10. ✅ 用 lark-cli 成功发送测试消息到飞书 P2P chat
11. ✅ 用 lark-cli 成功读取群聊消息
12. ✅ 验证 lark-cli 事件总线系统（`event list/status/consume/schema`）
13. ✅ 确认 lark-cli 支持 `im.message.receive_v1` 长连接事件监听
14. ✅ 分析 bus.log，确认 30 秒 consumer 轮询保活机制
15. ✅ 配置 lark-cli 使用用户机器人 appId `APP_ID_PLACEHOLDER`（--profile xiaot1）
16. ✅ 完成 OAuth Device Flow 授权
17. ✅ 发现 `--profile` 全局参数，解决事件总线冲突
18. ✅ bot 身份发送 P2P 消息成功
19. ✅ user 身份读取 P2P 消息成功
20. ✅ 定位事件总线冲突根因：WSL 小T (ws_client.py) 占用同一 appId
21. ✅ 决策：停止 WSL 服务，Windows lark-cli 接管事件监听
22. ✅ Windows 事件监听实测成功（收到飞书消息事件）
23. ✅ 实现完整链路代码（v0.0.7~0.0.10，含 sideband 文件协议）
24. ✅ 端到端联调成功：飞书消息 → lark-cli → Trae Agent → sideband → lark-cli → 飞书回复
25. ✅ v0.0.10 超时保护：maxWait 300s→600s + 30s 宽限期恢复 + 立即首次检查
26. ✅ package.json 添加 `onStartupFinished` 激活事件（扩展自动激活，但桥接仍需手动 Start）
27. ✅ v0.1.2 保活：扩展激活自动启动桥接 + 进程退出自动重启（指数退避 3s~60s）
28. ✅ v0.1.2 孤儿进程清理 + lark-cli 路径自动探测

### 待完成 📋
29. 📋 群聊消息支持（当前仅 P2P）
30. 📋 非文本消息处理（图片/文件/卡片消息）
31. 📋 多用户支持（当前硬编码单个 user-id）
32. 📋 优雅降级：事件监听不可用时自动切换到轮询方案
33. 📋 持久化日志（bridge.log 轮转，避免无限增长）
34. 📋 将 WSL 小T 的飞书能力完全迁移到 Windows Bridge

## 十、完整链路实现与迭代历史

### 10.1 版本迭代

| 版本 | 日期 | 核心变更 | 测试结果 |
|------|------|----------|----------|
| v0.0.1 | 08-04 | MVP 扩展，5 个命令，Clipboard Hack 发送 | ✅ 发送到 chat |
| v0.0.2 | 08-05 | 探测 icube 命令 + 原生飞书桥 | ✅ 发现 imBridge.* 命令 |
| v0.0.7 | 08-05 下午 | 完整链路首次实现：lark-cli 事件监听 + sideband 文件协议（30s超时轮询） | ❌ "飞书好了吗3" sideband 30s超时 |
| v0.0.8 | 08-05 下午 | 并发轮询修复：先等 Agent 状态 WaitingInput，再轮询 sideband 文件 | ✅ "飞书好了吗4" 端到端成功，67s |
| v0.0.9 | 08-05 下午 | fs.watch 零延迟 + 自适应轮询 + 双重读取校验 | ✅ "飞书好了吗5" 端到端成功，10s |
| v0.0.10 | 08-05 下午 | 超时保护：maxWait 300s→600s + 30s 宽限期重试 + 立即首次检查 | ⚠️ 复杂任务触发超时恢复机制 |
| v0.1.0 | 08-05 下午 | 持久 session 复用：飞书消息共享同一 session + `/新对话` 重置 + 30min 超时自动重置 | 🔄 首条创建 session，后续复用保持上下文 |
| v0.1.1 | 08-05 晚 | Session 智能复用策略 D（session 丢失时复用当前 chat 面板会话）+ 全链路详细日志（7 个模块标签）+ PERF 计时（7 阶段时间戳覆盖所有退出路径） | ✅ Session 健壮性大幅提升；日志结构化便于排查；耗时数据可指导后续优化 |
| v0.1.2 | 08-05 晚 | 保活机制：扩展激活自动启动桥接 + lark-cli 退出自动重启（指数退避 3s→60s，连接恢复后清零）+ 孤儿进程清理（PID 文件 + 进程名校验，防双连接重复消息）+ lark-cli 路径自动探测 | ✅ 只要 Trae 打开，飞书持续在线；异常/超时退出自动恢复，无需手动干预 |

### 10.2 v0.0.7 首次失败分析

**问题**：sideband 文件 30 秒超时未出现
```
[15:10:24] [收到] 飞书消息: "飞书好了吗3"
[15:10:25] [发送] OK, sessionId: 6a72e1e08129
[15:10:26] [状态] WaitingInput (1s)
[15:10:26] [完成] Agent 回复完成
[15:10:56] [TIMEOUT] sideband 文件 30秒内未出现
```

**根因**：v0.0.7 的逻辑是先等 Agent 完成（WaitingInput），然后才开始 30 秒 sideband 文件轮询。但 Agent 回复是**异步**的——Agent 返回 WaitingInput 只表示对话结束，Write 工具写入 sideband 文件可能在 Agent 主动线程之后的异步步骤中。Bridge 等 Agent 完成后再等 30 秒，可能 Agent 的 Write 操作还没执行。

### 10.3 v0.0.8 修复：并发轮询

**关键变更**：不再先等 Agent 完成再轮询文件，而是**同时轮询** Agent 状态和 sideband 文件

```javascript
// v0.0.7 (失败): 串行
await waitAgentComplete();      // 等 Agent 回复完成
await pollSidebandFile(30s);    // 然后才等文件

// v0.0.8 (成功): 并发
while (notTimeout) {
  checkAgentStatus();           // 检查 Agent 状态
  checkSidebandFile();          // 同时检查文件
  await sleep(500);
}
```

**结果**：端到端成功，但总延迟 67 秒（Agent 处理 + 文件写入较慢）

### 10.4 v0.0.9 优化：fs.watch + 自适应轮询 + 双重读取校验

三项优化：

1. **fs.watch 零延迟检测**：监听 replies 目录变化，文件出现时立即读取，无需等待轮询间隔
2. **自适应轮询间隔**：前 30 秒 500ms，之后 200ms，Agent 完成后 100ms
3. **双重读取校验**：连续读取两次 + 50ms 间隔 + 长度一致 = 文件写入完成，防止读到半截内容

```javascript
async function tryReadSideband() {
  const firstRead = fs.readFileSync(sidebandFile, 'utf8').trim();
  if (!firstRead) return null;
  await sleep(50);  // 等文件系统 flush
  const secondRead = fs.readFileSync(sidebandFile, 'utf8').trim();
  if (secondRead && secondRead.length === firstRead.length) {
    return secondRead;  // 长度一致 → 写入完成
  }
  return null;  // 长度不一致 → Agent 仍在写入
}
```

**结果**：10 秒内完成端到端回复（v0.0.8 的 67s → v0.0.9 的 10s）

### 10.4b v0.0.10 优化：超时保护 + 宽限期恢复 + 立即首次检查

**触发原因**：v0.0.9 的 300s（5 分钟）超时对复杂任务不够。用户发"整理文档"指令时，Agent 处理时间超过 5 分钟，sideband 文件未及时出现，触发超时后回复了"读取超时"通知——但 Agent 实际仍在工作，最终写出的回复被丢弃。

**三项优化**：

1. **maxWait 提升 300s → 600s**：将主轮询超时从 5 分钟延长到 10 分钟，覆盖大多数复杂任务
2. **30s 宽限期重试（6 × 5s）**：超时后不立即放弃，而是额外做 6 次 5 秒间隔的重试检查 sideband 文件是否出现。如果文件出现，读取实际回复并发送（RECOVERY 逻辑），防止消息丢失
3. **立即首次检查**：进入轮询循环前，先检查 sideband 文件是否已存在（Agent 可能已秒级完成），存在则直接读取发送，跳过整个轮询流程

```javascript
// v0.0.10 超时保护核心逻辑

// 1. 立即首次检查（Agent 可能已秒级完成）
if (fs.existsSync(sidebandFile)) {
  const content = fs.readFileSync(sidebandFile, 'utf8').trim();
  if (content) {
    fs.unlinkSync(sidebandFile);
    await sendFeishuReply(content);
    return;  // 跳过整个轮询
  }
}

// 2. 主轮询循环（maxWait = 600000，即 10 分钟）
while (Date.now() - startTime < maxWait) {
  // fs.watch 零延迟检测 + 自适应轮询 + 双重读取校验（同 v0.0.9）
  ...
}

// 3. 超时后 30s 宽限期重试（防消息丢失）
log(`[TIMEOUT] ${...}秒等待超时，检查 sideband 文件...`);
for (let i = 0; i < 6; i++) {
  await sleep(5000);  // 5 秒间隔
  if (fs.existsSync(sidebandFile)) break;  // 文件出现，跳出重试
}

// 4. 宽限期内文件出现 → RECOVERY 读取并发送实际回复
if (fs.existsSync(sidebandFile)) {
  const replyContent = fs.readFileSync(sidebandFile, 'utf8').trim();
  if (replyContent) {
    fs.unlinkSync(sidebandFile);
    await sendFeishuReply(replyContent);  // 发送实际回复，非超时通知
    return;
  }
}

// 5. 文件始终未出现 → 发送超时通知
await sendFeishuReply('（Agent 回复读取超时，请重新发送消息）');
```

### 10.5 架构（v0.0.10 当前版本）

```
飞书用户发消息
    ↓
lark-cli event consume (子进程, --profile xiaot1)
    ↓ (stdout JSON 事件)
enqueueEvent → 去重 → 消息队列
    ↓
handleFeishuEvent:
    1. 发送到 Trae Agent (icube.chat.sendToAgentNonBlocking, newSession)
       消息内容: "[飞书消息] 用户说：xxx\n[系统指令] 请将回复写入文件：replies/<msgId>.txt"
    2. 立即首次检查 sideband 文件（Agent 可能已秒级完成）
    3. 并发轮询 (maxWait=600s):
       - fs.watch 检测 sideband 文件（零延迟）
       - 自适应轮询读取 sideband 文件（fallback）
       - 双重读取校验（防半截内容）
       - 轮询 icube.chat.getSessionRunningStatus（状态监控）
    4. 超时保护：30s 宽限期重试（6×5s），文件出现则 RECOVERY 读取
    5. 读取到回复内容 → 删除 sideband 文件 → lark-cli im +messages-send 发送到飞书
```

### 10.4c v0.1.0 优化：持久 Session 复用 + 会话重置

> ⚠️ 历史实现（v0.1.0）。已在 **v0.1.6（P2c）** 被替换为「按 `chat_id` 存档优先复用 + 全程单次发送 + 回读确认落点，超时 12 小时」，见 gateway-architecture.md §五 P2c。

**问题**：v0.0.7~v0.0.10 每条飞书消息都用 `newSession: true` 创建新 session，导致 Agent 无法在多轮对话中保持上下文。

**方案**：维护飞书专用持久 session，首条消息创建后复用。

**核心机制**：
1. **Session 创建/复用**：`feishuSessionId` 变量保存当前飞书桥 session ID
   - 首次消息 → `newSession: true` 创建新 session，保存 sessionId
   - 后续消息 → 尝试通过 `sessionId`/`session_id`/`targetSessionId` 参数复用已有 session
   - 若 API 不支持 sessionId 参数（返回新 sessionId），自动回退到 `newSession: true`
2. **Session 重置触发条件**：
   - 用户在飞书发送 `/新对话`、`/reset`、`/new`、`/重置对话`
   - 30 分钟无消息自动超时重置（`SESSION_RESET_TIMEOUT`）
   - Session 复用失败时强制重置后重试
3. **Session 生命周期**：扩展激活期间持续存在，扩展停用时清理

```javascript
// Session 管理核心
let feishuSessionId = null;
let feishuSessionLastUsed = 0;
const SESSION_RESET_TIMEOUT = 30 * 60 * 1000;

async function trySendToAgent(message, sidebandFile) {
  // 1. 检查重置指令
  if (SESSION_RESET_COMMANDS.some(cmd => message.trim() === cmd)) {
    resetFeishuSession('用户指令');
    return { resetCommand: true, replyText: '已重置对话' };
  }

  // 2. 检查超时
  if (feishuSessionId && Date.now() - feishuSessionLastUsed > SESSION_RESET_TIMEOUT) {
    resetFeishuSession('超时');
  }

  // 3. 尝试复用（3 种参数格式）
  if (feishuSessionId) {
    const sessionAttempts = [
      { sessionId: feishuSessionId, newSession: false },
      { session_id: feishuSessionId, newSession: false },
      { targetSessionId: feishuSessionId, newSession: false },
    ];
    for (const opts of sessionAttempts) {
      const r = await executeCommand('icube.chat.sendToAgentNonBlocking', [message], { ...opts });
      if (r?.sessionId === feishuSessionId) {
        return { sendResult: r };  // 复用成功
      }
      // 返回不同 sessionId → API 不支持，回退
    }
  }

  // 4. 回退：创建新 session
  const sendResult = await executeCommand('icube.chat.sendToAgentNonBlocking', [message], { newSession: true });
  feishuSessionId = sendResult?.sessionId;
  feishuSessionLastUsed = Date.now();
  return { sendResult };
}
```

**新增命令**：
- `XiaoT1 Bridge: Reset Feishu Session` — 手动重置飞书 session
- 飞书指令：`/新对话` / `/reset` / `/new` / `/重置对话`

**注意事项**：
- 如果 API 不支持 sessionId 参数，系统会自动回退到 newSession 模式，功能不受影响
- 复用 session 时，Agent 会看到之前所有飞书对话历史，需注意上下文长度
- 30 分钟超时是默认值，可按需调整 `SESSION_RESET_TIMEOUT`

### 10.6 关键设计

#### Sideband 文件协议
- **原因**：`icube.chat.copyLastTurnDebugInfo` 不可用，无法直接读取 Trae chat 回复
- **方案**：在发送给 Agent 的消息中附加指令，让 Agent 用 Write 工具把回复写入文件
- **文件路径**：`e:\Trae\feishu-bridge\replies\<message_id>.txt`
- **流程**：Agent 回复 → 写入 sideband 文件 → Bridge fs.watch/轮询读取 → 双重校验 → 删除文件 → 发回飞书
- **完整性保证**：双重读取（50ms 间隔 + 长度一致性校验），防止读到 Agent 正在写入的半截内容

#### 消息去重
- 用 `event_id` 去重（飞书事件全局唯一 ID）
- 去重集合超过 100 条时，保留最近 50 条

#### 消息队列
- 串行处理（避免并发干扰 Trae Agent）
- `isProcessing` 标志位防止重复启动处理器

#### 错误处理
- Agent 发送失败 → 直接回复错误到飞书
- Agent 超时（10分钟主轮询 + 30s 宽限期）→ 宽限期内文件出现则恢复读取，否则回复超时提示
- sideband 文件读取超时 → 回复读取超时提示（v0.0.10 增加宽限期恢复，防消息丢失）

### 10.7 全部命令（7 个）

| 命令 | 功能 | 版本 |
|------|------|------|
| `XiaoT1 Bridge: Health Check` | 健康检查 | v0.0.1 |
| `XiaoT1 Bridge: Test Chat Send (Clipboard Hack)` | 剪贴板方式测试发送 | v0.0.1 |
| `XiaoT1 Bridge: Test Chat Send (icube Native API)` | icube 原生 API 测试发送 | v0.0.1 |
| `XiaoT1 Bridge: Probe APIs` | 探测所有 icube.* 命令 | v0.0.2 |
| `XiaoT1 Bridge: Probe Feishu Bridge` | 探测原生飞书桥接口 | v0.0.2 |
| `XiaoT1 Bridge: Start Full Bridge` | 启动完整飞书桥接 | v0.0.7 |
| `XiaoT1 Bridge: Stop Full Bridge` | 停止飞书桥接 | v0.0.7 |
| `XiaoT1 Bridge: Reset Feishu Session` | 重置飞书持久会话 | v0.1.0 |

### 10.8 配置常量

```javascript
const LARK_CLI = 'C:\\Users\\yuanw\\.trae-cn\\plugins\\trae-remote-official\\lark\\1.0.3\\bin\\lark-cli.exe';
const LARK_PROFILE = 'xiaot1';           // 用户机器人 profile
const FEISHU_USER_ID = 'ou_xxx';  // （用户名）
const REPLIES_DIR = 'e:\\Trae\\feishu-bridge\\replies';         // sideband 文件目录
const BRIDGE_TIMEOUT = '3600s';          // event consume 超时（1小时）
const SESSION_RESET_TIMEOUT = 30 * 60 * 1000;  // 飞书 session 超时重置（30分钟）
const SESSION_RESET_COMMANDS = ['/新对话', '/reset', '/new', '/重置对话'];
```

### 10.9 使用步骤

1. 确保已停止 WSL 上的 ws_client.py（避免事件总线冲突）
2. 重新加载 Trae 窗口（Developer: Reload Window）
3. Ctrl+Shift+P → `XiaoT1 Bridge: Start Full Bridge`
4. 在飞书中给机器人发消息
5. Trae Agent 处理后，回复会自动发回飞书
6. 停止：Ctrl+Shift+P → `XiaoT1 Bridge: Stop Full Bridge`

---

## 十一、WSL 迁移记录

### 11.1 迁移前状态

WSL 上运行两个飞书 WebSocket 客户端进程：
- PID 74097: `python3 -m lark_integration.ws_client`（CC1 遗留，Jul31 启动）
- PID 286589: `python3 /root/xiaot1/ws_client.py`（小T 主服务，Aug03 启动）

两者都使用同一 appId `APP_ID_PLACEHOLDER`，通过飞书 WebSocket 长连接接收消息。

### 11.2 迁移决策

**原因**：飞书服务器对同一 appId 只允许一个事件总线连接。WSL 占用后，Windows lark-cli 无法启动事件监听（报错 `online_instance_cnt=1`）。

**决策**：停止 WSL 服务，Windows lark-cli 接管。

```bash
# 停止 WSL 上的飞书服务
wsl -d Ubuntu-22.04 -- bash -c "kill 74097 286589"
```

### 11.3 迁移后状态

| 能力 | WSL（迁移前） | Windows Bridge（迁移后） |
|------|--------------|------------------------|
| 接收消息 | ws_client.py WebSocket | lark-cli event consume |
| 发送回复 | lark_oapi SDK | lark-cli im +messages-send |
| 处理消息 | xiaot1-cli.py | Trae Agent (icube.chat) |
| 读取回复 | 直接输出 | sideband 文件协议 |

**注意事项**：WSL 小T 的飞书能力已停止。如需恢复，需重新启动 ws_client.py（但会导致 Windows 事件监听冲突）。

---

## 十二、飞书实现完整流程总结（2026-08-05）

### 12.1 总体架构决策

**最终方案：路径 B（lark-cli）+ 路径 C（自建 VSCode 扩展）混合架构**

```
飞书 ←→ lark-cli（事件收发） ←→ XiaoT1 Bridge 扩展 ←→ icube API（Agent 通信）
                                                          ↕
                                              Sideband 文件（回复读取）
```

**放弃的路径**：
- ❌ 路径 A（原生桥 `icube.imBridge.feishu.*`）：login 无法绑定
- ❌ CDP/browser_use：Trae CN 封闭架构，外部浏览器无法访问
- ❌ SQLite 数据库：SQLCipher 加密，无密钥
- ❌ webview 操作：`sendCommand` 同步阻塞卡死扩展宿主

**选择的路径**：
- ✅ lark-cli：Trae 内置 CLI 工具，OAuth 已配置，支持事件监听
- ✅ Sideband 文件协议：绕过 Trae 内部状态读取限制

### 12.2 数据流完整时序

```
[飞书用户]     [lark-cli]      [Bridge 扩展]    [Trae Agent]     [Sideband 文件]
    │  发消息    │                  │                │                │
    │──────────→│                  │                │                │
    │            │ event consume   │                │                │
    │            │ (NDJSON 输出)   │                │                │
    │            │───────────────→│                │                │
    │            │                  │ 去重+入队      │                │
    │            │                  │ processQueue   │                │
    │            │                  │─────────────→│                │
    │            │                  │  sendToAgentNonBlocking        │
    │            │                  │  (附加写入指令)  │                │
    │            │                  │                │─────┐          │
    │            │                  │                │     │ Agent 处理  │
    │            │                  │                │     │ 回复生成    │
    │            │                  │                │     └─────↓          │
    │            │                  │                │──────────────→│
    │            │                  │                │  Write 工具写入 │
    │            │                  │                │                │
    │            │                  │ fs.watch/轮询  │                │
    │            │                  │ 双重读取校验    │                │
    │            │                  │←──────────────│                │
    │            │                  │ 读取回复内容    │                │
    │            │                  │ 删除 sideband  │                │
    │            │                  │                │                │
    │            │ im +messages-send                 │                │
    │            │←────────────────│                │                │
    │←──────────│                  │                │                │
    │  收到回复   │                  │                │                │
```

### 12.3 关键技术实现

#### 12.3.1 事件监听系统

```javascript
// 启动 lark-cli 事件消费子进程
const args = [
  '--profile', 'xiaot1',
  'event', 'consume', 'im.message.receive_v1',
  '--as', 'bot',
  '--timeout', '3600s'
];

bridgeProcess = spawn(LARK_CLI, args, {
  stdio: ['pipe', 'pipe', 'pipe'],
  windowsHide: true
});

// 解析 NDJSON 输出
bridgeProcess.stdout.on('data', (data) => {
  const lines = data.toString().split('\n');
  for (const line of lines) {
    if (line.trim().startsWith('{')) {
      const event = JSON.parse(line);
      enqueueEvent(event);
    }
  }
});
```

#### 12.3.2 Sideband 文件协议（核心创新）

**问题**：Trae Agent 回复无法直接通过 API 读取（`copyLastTurnDebugInfo` 权限门控）

**解决方案**：在发送给 Agent 的消息中附加系统指令

```javascript
// 构造消息（附加 sideband 写入指令）
const agentMessage = `[飞书消息] 用户说：${content}

[系统指令] 请将回复内容写入文件：${sidebandFile}`;

// 轮询等待回复（三重保障）
// 1. fs.watch 零延迟检测
// 2. 自适应轮询（500ms→200ms→100ms）
// 3. 双重读取校验（50ms间隔+长度一致性）
```

**双重读取校验机制**：
```javascript
async function tryReadSideband() {
  const firstRead = fs.readFileSync(sidebandFile, 'utf8').trim();
  if (!firstRead) return null;
  await sleep(50);  // 等待文件系统 flush
  const secondRead = fs.readFileSync(sidebandFile, 'utf8').trim();
  if (secondRead && secondRead.length === firstRead.length) {
    return secondRead;  // 长度一致 = 写入完成
  }
  return null;  // 长度不一致 = Agent 仍在写入
}
```

#### 12.3.3 持久 Session 复用（v0.1.0 + v0.1.1 增强）

> ⚠️ 历史实现（v0.1.0/v0.1.1）。已在 **v0.1.6（P2c）** 被替换为「按 `chat_id` 存档优先复用 + 全程单次发送 + 回读确认落点，超时 12 小时」，见 gateway-architecture.md §五 P2c。

```javascript
// Session 管理变量
let feishuSessionId = null;
const SESSION_RESET_TIMEOUT = 30 * 60 * 1000;  // 30分钟

// 发送时尝试复用 session（4 级策略 + PERF 计时）
async function trySendToAgent(message, sidebandFile) {
  // 0. 记录 PERF T2 发送开始时间
  markPerf(sidebandFile, 'T2', '开始发送 Agent');

  // 1. 检查重置指令
  if (['/新对话', '/reset', '/new', '/重置对话'].includes(message.trim())) {
    resetFeishuSession('用户指令');
  }

  // 2. 策略 A: feishuSessionId 存在 → 用 sessionId 参数复用
  if (feishuSessionId) {
    logger.info(`[Session] 尝试复用 session: ${feishuSessionId}...`);
    for (const opts of sessionAttempts) {
      const key = Object.keys(opts)[0];
      logger.info(`[Session] 尝试 ${key} 参数`);
      const r = await executeCommand('icube.chat.sendToAgentNonBlocking', 
        [message], { ...opts });
      logger.info(`[Session] 尝试 ${key} 参数, 返回 sessionId: ${r?.sessionId || 'null'}`);
      if (r?.sessionId === feishuSessionId) {
        logger.info(`[Session] ✅ 复用成功`);
        markPerf(sidebandFile, 'T3', 'Agent 发送完成 (session 复用)');
        return r;
      }
    }
    logger.info(`[Session] ⚠️ 参数匹配失败，尝试策略 D`);
  }

  // 3. 策略 D（v0.1.1 新增）: feishuSessionId 为 null → 复用当前 chat 面板会话
  if (!feishuSessionId) {
    logger.info(`[Session] feishuSessionId 为 null，获取当前 chat 会话`);
    try {
      const r0 = await executeCommand('icube.chat.getCurrentSessionId', []);
      const sid = r0?.sessionId || r0?.result?.sessionId;
      if (sid) {
        logger.info(`[Session] 当前 chat 会话: ${sid}`);
        for (const opts of sessionAttempts) {
          const r = await executeCommand('icube.chat.sendToAgentNonBlocking',
            [message], { ...opts });
          if (r?.sessionId === sid) {
            feishuSessionId = r.sessionId;
            logger.info(`[Session] ✅ 策略 D 复用成功`);
            markPerf(sidebandFile, 'T3', 'Agent 发送完成 (策略 D)');
            return r;
          }
        }
      }
    } catch (e) {
      logger.info(`[Session] 当前 chat 无活跃会话: ${e.message}`);
    }
  }

  // 4. 兜底: 创建新 session
  logger.info(`[Session] 创建新 session`);
  const r = await executeCommand('icube.chat.sendToAgentNonBlocking', 
    [message], { newSession: true });
  feishuSessionId = r?.sessionId;
  logger.info(`[Session] 新 sessionId: ${feishuSessionId}`);
  markPerf(sidebandFile, 'T3', 'Agent 发送完成 (新 session)');
  return r;
}
```

#### 12.3.4 超时保护与恢复机制（v0.0.10）

```javascript
// 主轮询：600秒（10分钟）
while (Date.now() - startTime < 600000) {
  // fs.watch + 自适应轮询 + 双重读取校验
  await checkSideband();
}

// 超时后宽限期：30秒（6×5s），防消息丢失
for (let i = 0; i < 6; i++) {
  await sleep(5000);
  if (fs.existsSync(sidebandFile)) break;  // 文件出现，跳出
}

// RECOVERY：宽限期内文件出现，读取实际回复发送
if (fs.existsSync(sidebandFile)) {
  const content = fs.readFileSync(sidebandFile, 'utf8').trim();
  await sendFeishuReply(content);  // 发送实际回复，非超时通知
} else {
  await sendFeishuReply('（Agent 回复读取超时，请重新发送消息）');
}
```

#### 12.3.5 Session 智能复用 + 全链路日志 + PERF 计时（v0.1.1）

> ⚠️ 历史实现（v0.1.1）。其中「4 级复用策略」已在 **v0.1.6（P2c）** 被替换为「按 `chat_id` 存档优先复用 + 全程单次发送 + 回读确认落点，超时 12 小时」，见 gateway-architecture.md §五 P2c。

##### 4 级 Session 复用策略

```
策略 A: feishuSessionId 存在
  → icube.chat.sendToAgentNonBlocking(message, { sessionId: feishuSessionId })
  → 传递保存的 sessionId 参数

策略 D: feishuSessionId 为 null + 当前 chat 有活跃会话（v0.1.1 新增）
  → icube.chat.getCurrentSessionId() 获取当前 chat 面板会话
  → 遍历尝试 sessionId / session_id / targetSessionId 三种参数名
  → 复用当前 chat 面板的活跃会话

策略 B: 保存的 session 与当前会话匹配
  → 直接发送到活跃会话，无需传递 sessionId

兜底: 所有策略失败
  → icube.chat.sendToAgentNonBlocking(message, { newSession: true })
  → 创建全新 session
```

**实测验证**：`icube.chat.sendToAgentNonBlocking` 确实支持 `sessionId` 参数，日志显示返回的 sessionId 与传入的一致：
```
[Session] 尝试复用 session: SESSION_ID_PLACEHOLDER...
[Session] 尝试 sessionId 参数, 返回 sessionId: SESSION_ID_PLACEHOLDER
[Session] ✅ 复用成功
```

##### 全链路日志标签体系（7 个模块）

| 标签 | 覆盖范围 | 关键内容 |
|------|---------|---------|
| `[lark-cli]` | lark-cli stdout 解析 | 事件编号、eventId、消息类型、解析失败详情 |
| `[enqueueEvent]` | 事件入队 | 参数预览、去重检查、入队后队列长度、timingMap 清理 |
| `[processQueue]` | 队列处理 | 处理中跳过原因、逐条处理进度、成功/失败统计 |
| `[handleFeishuEvent]` | 消息处理主流程 | 消息参数、发送前 session 状态、fs.watch 命中、轮询计数、心跳日志 |
| `[Session]` | Session 管理 | 加载/保存/清除/重置的完整操作记录 |
| `[sendFeishuReply]` | 飞书回复发送 | 字符数预览、lark-cli 执行结果、发送成功 message_id |
| `[PERF]` / `[PERF-END]` | 性能计时 | 7 阶段时间戳、每段耗时、总耗时分析报告 |

##### PERF 7 阶段时间戳

| 标签 | 含义 | 记录位置 |
|------|------|---------|
| T0 | 事件接收（lark-cli → enqueueEvent） | enqueueEvent |
| T1 | 开始处理（processQueue → handleFeishuEvent） | handleFeishuEvent 入口 |
| T2 | 开始发送 Agent | trySendToAgent 入口 |
| T3 | Agent 发送完成（sendToAgentNonBlocking 返回） | trySendToAgent 返回 |
| T4 | 开始等待 sideband | 轮询循环前 |
| T5 | Sideband 文件检测到 | 回复读取成功时 |
| T7 | 飞书回复发送完成（lark-cli 返回） | sendFeishuReply().then() |

##### PERF-END 输出示例

```
[PERF-END] ╔══════════════════════════════════════════════════════╗
[PERF-END] ║ 飞书消息处理完成 (fs.watch 路径)
[PERF-END] ║ messageId: om_xxx...
[PERF-END] ║ T0→T1 入队→处理: 2ms
[PERF-END] ║ T1→T2 处理→发送: 1ms
[PERF-END] ║ T2→T3 发送→完成: 15ms           ← icube API 耗时
[PERF-END] ║ T3→T4 完成→等待: 1ms
[PERF-END] ║ T4→T5 等待→文件: 8200ms        ← Agent 思考时间
[PERF-END] ║ T5→T7 文件→飞书: 230ms         ← lark-cli 发送
[PERF-END] ║ TOTAL T0→T7: 8449ms
[PERF-END] ╚══════════════════════════════════════════════════════╝
```

##### 5 条退出路径均覆盖 PERF-END

1. **立即路径**（sideband 文件在首次检查时已就绪）
2. **fs.watch 路径**（文件变化事件触发读取）
3. **轮询路径**（定时轮询读取文件）
4. **RECOVERY 路径**（超时宽限期后文件出现）
5. **TIMEOUT 路径**（始终未检测到文件）

##### 内存保护机制

- `timingMap` 超过 20 条时自动清理 5 分钟前的过期条目（enqueueEvent 中触发）
- 所有退出路径（成功/失败/超时/重置/非文本）均有 `timingMap.delete(messageId)` 清理

### 12.4 消息处理流水线

```
1. 接收 → lark-cli event consume → NDJSON 解析
2. 去重 → event_id 去重（Set，超100条保留最近50）
3. 入队 → messageQueue 串行处理（防并发干扰）
4. 发送 → icube.chat.sendToAgentNonBlocking
5. 监听 → fs.watch + 自适应轮询 sideband 文件
6. 校验 → 双重读取（长度一致性校验）
7. 回复 → lark-cli im +messages-send --as bot
8. 清理 → 删除 sideband 文件 + 更新 session 状态
```

### 12.5 全部失败路径总结

| 路径 | 尝试方法 | 失败原因 | 教训 |
|------|----------|----------|------|
| 外部浏览器 | browser_use + Chrome CDP | Trae CN 代码层面禁用 CDP | 封闭架构必须用内部 API |
| 原生飞书桥 | icube.imBridge.feishu.login | OAuth 认证流程无法通过代码完成 | 内部桥依赖外部 OAuth |
| Agent 回复读取 | copyLastTurnDebugInfo | 权限门控"not supported" | 普通用户无权限 |
| SQLite 数据库 | 直接读取 database.db | SQLCipher 加密 | 无密钥无法解密 |
| tabGroups 读取 | vscode.window.tabGroups | Chat 是 panel 不是 editor tab | UI 结构限制 |
| webview 操作 | icube.webview.sendCommand | 同步阻塞卡死扩展宿主 | 必须避免调用 |
| DevTools DOM | openDeveloperTools | CDP 禁用无法获取 DOM | 架构限制 |

### 12.6 Bug 修复记录

#### Bug: 飞书回复只收到1个字

**现象**：用户反馈飞书消息只收到1个字"飞"，回复内容被严重截断。

**根因**：`sendFeishuReply` 函数使用 `--text` 参数直接传递回复文本给 lark-cli。当回复内容包含中文、换行符、引号等特殊字符时，命令行参数解析会出问题。

**修复方案**：改用 `--content` 参数，使用 JSON 格式安全传递内容：

```javascript
// 修复前（有问题）
function sendFeishuReply(replyText) {
  const args = ['--text', replyText];  // 直接传递，特殊字符会导致截断
}

// 修复后（正确）
function sendFeishuReply(replyText) {
  const contentJson = JSON.stringify({ text: replyText });  // JSON 转义
  const args = ['--content', contentJson];  // 使用 --content 参数
}
```

**验证**：用 Node.js `execFile` 测试，发送包含中文和换行符的内容成功。

**版本**：v0.1.0（2026-08-05 修复）

### 12.7 成功关键因素

1. **封闭架构认知**：接受 Trae CN 是封闭系统，只能通过 VSCode 扩展 + icube API 操作
2. **lark-cli 发现**：Trae 已内置完整的飞书 CLI 工具，节省大量开发时间
3. **Sideband 创新**：创造性地用文件协议绕过 Trae 内部状态读取限制
4. **持久 Session**：v0.1.0 实现上下文保持，支持多轮对话
5. **超时保护**：v0.0.10 增加 600s 超时 + 30s 宽限期恢复，防止消息丢失
6. **双重校验**：50ms 间隔 + 长度一致性，确保读取完整文件
7. **事件去重**：全局唯一 event_id 去重，防止重复处理
8. **WSL 冲突解决**：停止 WSL ws_client，Windows 接管事件监听

### 12.7 当前系统边界

✅ **已实现能力**：
- P2P 文本消息双向通信
- 实时事件监听（lark-cli 长连接）
- Sideband 文件协议回复读取
- 持久 Session 多轮对话（按 `chat_id` 固定映射；存档会话可运行则复用，否则回退当前聚焦面板，落点回读确认）
- `/新对话` 指令重置会话
- 12 小时无消息自动重置
- 600s 超时保护 + 30s 宽限期恢复
- 消息去重与排队处理
- 全链路结构化日志（7 模块标签体系）
- PERF 7 阶段耗时计时（覆盖所有退出路径）
- 内存保护（timingMap 自动清理）
- 保活：扩展激活时自动启动桥接（无需手动点命令）
- 保活：lark-cli 退出自动重启（指数退避 3s~60s，连接恢复后清零）
- 孤儿进程清理（PID 文件 + 进程名校验，防 Trae 异常退出后的双连接）

⚠️ **当前限制**：
- 仅支持 P2P 消息（群聊未实现）
- 仅支持文本消息（图片/文件/卡片未处理）
- lark-cli event consume 1 小时超时（v0.1.2 起自动重启，但重启瞬间约 3~5s 不可用）
- 硬编码单个用户（FEISHU_USER_ID 固定）
- 依赖 Agent 配合写文件（如 Agent 忽略指令则回复丢失）
- 扩展缓存问题（修改代码后需删除 CachedData）
- Session 长期使用可能上下文膨胀

### 12.8 快速启动清单

1. **前置条件**：
   - 已停止 WSL ws_client.py（`wsl -d Ubuntu-22.04 -- bash -c "kill 74097 286589"`）
   - lark-cli 已配置 xiaot1 profile 并完成 OAuth 认证
   - `C:\Users\{username}\.lark-cli\config.json` 配置正确
   - `e:\Trae\feishu-bridge\replies\` 目录存在

2. **启动步骤**：
   ```
   # 1. 重新加载 Trae 窗口（Developer: Reload Window）
   # 2. Ctrl+Shift+P → "XiaoT1 Bridge: Start Full Bridge"
   # 3. 等待 lark-cli 事件连接（log: feishu-websocket: connected）
   # 4. 飞书发消息测试
   # 5. 停止：Ctrl+Shift+P → "XiaoT1 Bridge: Stop Full Bridge"
   ```

3. **验证方法**：
   - Output 面板查看 Bridge 日志
   - `bridge.log` 文件查看完整运行记录
   - 飞书机器人回复确认链路正常

### 12.9 版本迭代历史（完整版）

```
v0.0.1 (08-04) → MVP 扩展，5 个命令，Clipboard Hack 发送
v0.0.2 (08-05) → 探测 icube 命令 + 原生飞书桥（发现 25 个 imBridge.* 命令）
v0.0.7 (08-05) → 完整链路首次实现（sideband 30s 超时轮询，失败）
v0.0.8 (08-05) → 并发轮询修复（成功，67s 回复延迟）
v0.0.9 (08-05) → fs.watch + 自适应轮询 + 双重校验（10s 回复延迟）
v0.0.10 (08-05) → 超时保护：600s + 30s 宽限期恢复（防消息丢失）
v0.1.0 (08-05) → 持久 Session 复用 + 会话重置（支持多轮对话）
v0.1.1 (08-05) → Session 智能复用策略 D + 全链路详细日志 + PERF 7 阶段计时
v0.1.2 (08-05) → 保活自动重启（指数退避）+ 孤儿进程清理 + lark-cli 路径自动探测
v0.1.3 (10-03) → 基座暴露通用扩展点 registerInboundInterceptor（具体增强外移独立扩展，见 gateway-architecture.md P1）；修正公开 API 暴露方式：改为 activate() 返回 { registerInboundInterceptor }（VS Code extension.exports 取 activate 返回值，非 module.exports）
v0.1.4 (10-04) → 网关概念落地（P2）：adapter 注册表 + OutboundHook + 每适配器错误隔离，飞书逻辑原位注册为内置 adapter
v0.1.5 (10-10) → 固定话题（P2b）：飞书会话按 chat_id 固定映射到 Trae session；修复 /new 检测与「重置后被复用策略抢回」两个 latent bug
v0.1.6 (10-10) → 会话复用修复（P2c）：去掉三格式盲发与复用当前面板的重复投递/串场，改为存档优先、单次发送、回读确认；超时阈值 30 分钟 → 12 小时
v0.1.7 (10-10) → 复用落点确认 + 失败回退（P2d）：定向发往后台存档会话不被触发时，回退发送到当前聚焦面板，保证一定得到回复
```

## 十三、保活机制实现细节（v0.1.2）

### 13.1 设计目标

> **只要 Trae 处于打开状态，飞书就保持连接、可随时对话；只有当 Trae 自己退出时才断开。**

### 13.2 三大机制

| 机制 | 触发时机 | 行为 |
|------|----------|------|
| **激活自启动** | 扩展激活（`onStartupFinished`） | 自动 `startFullBridge()`，无需手动点命令 |
| **退出自动重启** | lark-cli 进程退出或启动失败 | 指数退避 3s→6s→…→60s 后重启；连接恢复后计数清零 |
| **孤儿进程清理** | 每次启动桥接前 | 读 PID 文件 → 校验进程名确为 `lark-cli.exe` → 清理残留 |

### 13.3 关键设计点

1. **区分手动停止与异常退出**：`bridgeManuallyStopped` 标志。用户点 `Stop Bridge` 后不自动重启；异常退出才重启。
2. **指数退避防风暴**：`delay = min(3000 × 2^(n-1), 60000)`，避免 lark-cli 持续起不来时疯狂重启。
3. **连接成功即清零退避**：stderr 出现 `connected` / `ready event_key` 时把 `bridgeRestartAttempts` 归零。
4. **自动重启跳过 sideband 清理**：`startFullBridge({isRestart:true})` 时不删除 `replies/` 里的文件，避免误删正在处理的回复。
5. **孤儿清理防双连接**：Trae 异常退出（不走 `deactivate`）时子进程可能残留，导致下次启动出现两个 lark-cli 同时订阅、消息重复。PID 文件 + 进程名校验可安全清理，且**只杀名字确为 lark-cli 的进程**，避免误杀 PID 被回收后的其他进程。

### 13.4 日志样例

```
[保活] 扩展已激活，自动启动飞书桥接...
=== 启动完整飞书桥接 ===
[lark-cli] 自动探测到路径: ...\lark\1.0.3\bin\lark-cli.exe
[孤儿清理] 历史 PID 12345 已不存在，无需清理
lark-cli event consume 已启动 (PID: 67890)
[lark-cli] [source] feishu-websocket: connected        ← 连接成功，退避计数清零
...
lark-cli event consume 已退出 (code: 0, signal: null)   ← 1 小时超时
[保活] lark-cli 已退出 (code=0, signal=null)，3000ms 后自动重启 (第 1 次)
[保活] 正在自动重启桥接...
=== [保活] 自动重启完整飞书桥接 ===
```

---

## 十四、Trae 升级影响评估

### 14.1 结论

**整体方案不会因 Trae 升级而"全盘失效"**——核心逻辑（Sideband 协议、消息队列、保活、去重、计时）都是扩展内部自研代码，与 Trae 版本无关。
但存在 **3 类外部依赖** 需要关注，其中 `lark-cli` 路径最脆弱（**v0.1.2 已加固**）。

### 14.2 依赖风险清单

| 依赖项 | 风险 | 升级后可能的变化 | 现状 |
|--------|------|------------------|------|
| **lark-cli 可执行路径（含版本号）** | 🔴 高 | 插件升级后目录变 `1.0.4`…，硬编码即失效 | ✅ 已改为自动探测最新版本目录 |
| **`icube.chat.sendToAgentNonBlocking`** | 🟠 中高 | 命令名/参数可能变（参数含 `enableUnstableFields`） | ⚠️ 未加固，升级后需回归 |
| **`icube.chat.getSessionRunningStatus`** | 🟠 中 | 同上 | ⚠️ 未加固 |
| **`icube.chat.getCurrentSessionId`** | 🟠 中 | 同上 | ⚠️ 未加固 |
| **lark-cli 子命令语法** | 🟡 低-中 | 子命令或参数可能调整 | ⚠️ 未加固 |
| **Sideband 文件协议** | 🟢 低 | 纯文件读写约定 | ✅ 不受影响 |
| **VSCode 扩展 API** | 🟢 低 | 标准公开 API | ✅ 不受影响 |
| **保活/队列/去重/日志** | 🟢 无 | 纯自研逻辑 | ✅ 不受影响 |

### 14.3 升级后回归清单（3 步）

1. **确认 lark-cli 路径**：日志中出现 `[lark-cli] 自动探测到路径: ...\lark\<新版本>\bin\lark-cli.exe`。
2. **端到端验证**：飞书发一条消息，确认能收到并回复。
3. **若 icube 命令报错**：运行 `Probe APIs` 重新枚举 `icube.*` 命令名，比对是否改名/改参数。

---

## 十五、保活验证用例

> 用于 v0.1.2 保活机制的验收与 Trae 升级后的回归。

| 用例 | 场景 | 操作步骤 | 预期结果 | 日志关键点 |
|------|------|----------|----------|-----------|
| **TC-01 激活自启动** | Trae 启动 / 重载窗口 | `Developer: Reload Window` | 无需手动点命令，桥接自动启动 | `[保活] 扩展已激活，自动启动飞书桥接...` |
| **TC-02 超时自动重启** | lark-cli 1 小时超时 | 等待到期（或用短 `--timeout` 模拟） | 退出后 3s 内自动重启 | `[保活] lark-cli 已退出...3000ms 后自动重启` |
| **TC-03 崩溃自动重启** | lark-cli 异常退出 | 任务管理器结束 `lark-cli.exe` | 自动重启，退避延迟递增 | `[保活] ... 第 N 次`，延迟 3s→6s→12s |
| **TC-04 退避清零** | 连接恢复 | 完成 TC-03 后确认连接成功再触发下一次退出 | 重启计数归零 | `[保活] 连接已恢复，重置重启计数 (原 N 次)` |
| **TC-05 手动停止不重启** | 用户主动停止 | `Stop Bridge` | 停止后**不**自动重启 | `[保活] 手动停止，不自动重启` |
| **TC-06 Trae 退出干净关闭** | 正常关闭 Trae | 关闭 Trae 窗口 | 桥接停止，无残留进程 | `扩展已停用` |
| **TC-07 孤儿进程清理** | Trae 异常退出后重开 | 强杀 Trae → 重新打开 → 触发启动 | 残留 lark-cli 被清理，仅一个连接 | `[孤儿清理] 发现残留 lark-cli 进程 (PID xxx)...` |
| **TC-08 误杀保护** | PID 被其他进程复用 | 往 `bridge.pid` 写非 lark-cli 的 PID → 启动桥接 | 跳过清理，不误杀 | `[孤儿清理] ... 非 lark-cli，跳过（避免误杀）` |
| **TC-09 路径自动探测** | Trae 升级后版本目录变化 | 目录改为新版本号（如 `1.0.4`）→ 重载窗口 | 自动选用新版本 | `[lark-cli] 自动探测到路径: ...\lark\1.0.4\...` |

---

## 文档维护说明

本文档记录了飞书桥接扩展的完整实现过程，包括：
- 探索历史时间线（Phase 1-5）
- 架构决策与方案对比
- 核心技术实现细节
- 保活机制与孤儿进程清理（v0.1.2）
- Trae 升级影响评估
- 验证用例

**最后更新**：2026-08-05
**当前版本**：v0.1.2（保活自动重启 + 孤儿进程清理 + lark-cli 路径自动探测）
**状态**：端到端链路已打通 ✅；只要 Trae 打开，飞书持续在线 ✅

**相关文件**：
- 扩展源码：[extension.js](./extension/extension.js)
- 构建指南：[feishu-build-guide.md](./docs/feishu-build-guide.md)

