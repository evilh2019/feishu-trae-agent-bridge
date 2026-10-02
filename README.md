# Feishu Trae Agent Bridge

让飞书消息在 Trae CN Agent 中处理的 VSCode 扩展桥接。通过 lark-cli + Sideband 文件协议，实现飞书 ↔ Trae Agent 的双向实时通信。

## ✨ 特性

- **双向通信**：飞书消息 → Trae Agent → 飞书回复，端到端打通
- **保活自动重连**：只要 Trae 打开，飞书持续在线；进程退出自动重启（指数退避 3s~60s）
- **孤儿进程清理**：Trae 异常退出后自动清理残留进程，避免双连接导致消息重复
- **路径自动探测**：自动适配 Trae 升级后的 lark 插件版本目录变化
- **Session 智能复用**：4 级策略保持多轮对话上下文
- **全链路日志**：7 模块标签体系，覆盖每个环节
- **PERF 性能计时**：7 阶段时间戳，覆盖所有退出路径
- **超时保护**：600s 主等待 + 30s 宽限期恢复
- **Sideband 协议**：创造性地用文件协议绕过 Trae 内部状态读取限制

## 🏗️ 架构

```
飞书用户 → 飞书服务器 → lark-cli event consume
                              ↓
                    Feishu Trae Agent Bridge 扩展
                    (Session 复用 → Agent 发送 → Sideband 轮询)
                              ↓
飞书用户 ← 飞书服务器 ← lark-cli messages-send
```

## 📦 安装

### 前提条件

- Trae CN 已安装（含内置 lark-cli）
- 飞书机器人账号
- lark-cli 已完成 OAuth 认证

### 步骤

1. **Clone 仓库**
   ```
   git clone https://github.com/evilh2019/feishu-trae-agent-bridge.git
   ```

2. **配置扩展**

   编辑 `extension/extension.js` 顶部的 `CONFIG` 对象：
   ```javascript
   const CONFIG = {
     LARK_CLI: '',           // lark-cli 路径（留空自动探测）
     LARK_PROFILE: 'xiaot1', // lark-cli profile 名称
     FEISHU_USER_ID: '',     // ⚠️ 填入你的飞书 open_id (ou_xxx)
     WORK_DIR: '',           // Bridge 工作目录（留空自动使用 ~/feishu-trae-agent-bridge）
     BRIDGE_TIMEOUT: '3600s',
   };
   ```

3. **加载扩展**

   将 `extension/` 目录复制到 Trae 扩展目录：
   ```
   # Windows
   copy -r extension/ %USERPROFILE%\.trae-cn\extensions\feishu-trae-agent-bridge\
   ```

   然后在 Trae 中执行 `Developer: Reload Window`。

4. **启动桥接**

   - 扩展在 Trae 启动时会**自动启动**桥接（保活），无需手动操作
   - 如需手动控制：`Ctrl+Shift+P` → "Feishu Trae Agent Bridge: Start Bridge"
   - 在飞书中发送消息测试

## 🔄 保活机制

> 只要 Trae 处于打开状态，飞书就保持连接、可随时对话；只有当 Trae 退出时才断开。

| 机制 | 说明 |
|------|------|
| 激活自启动 | 扩展激活时自动启动桥接 |
| 退出自动重启 | 进程退出/超时后指数退避重启（3s→60s），连接恢复后清零 |
| 孤儿进程清理 | PID 文件 + 进程名校验，安全清理 Trae 异常退出后的残留进程 |
| 手动停止保护 | 用户主动 Stop 后不自动重启 |

**Trae 升级兼容性**：lark-cli 路径会自动探测最新版本目录；`icube.chat.*` 等内部 API 若变更，升级后需回归验证。

## 📚 文档

完整构建过程和技术细节请参阅：[docs/feishu-build-guide.md](docs/feishu-build-guide.md)

## 🔧 技术实现

### Sideband 文件协议

```
Bridge 发送消息 → Agent 收到指令写入 replies/<msgId>.txt
                                              ↓
Bridge 用 fs.watch + 自适应轮询检测文件 → 读取内容 → 发回飞书
```

### Session 4 级复用策略

1. **策略 A**：feishuSessionId 存在 → sessionId 参数复用
2. **策略 D**：feishuSessionId 为 null → 复用当前 chat 面板会话
3. **策略 B**：保存的 session 匹配 → 直接发送
4. **兜底**：创建新 session

### PERF 7 阶段计时

| 标签 | 含义 |
|------|------|
| T0 | 事件接收 |
| T1 | 开始处理 |
| T2 | 开始发送 Agent |
| T3 | Agent 发送完成 |
| T4 | 开始等待 sideband |
| T5 | Sideband 文件检测到 |
| T7 | 飞书回复发送完成 |

## ⚠️ 限制

- 仅支持 P2P 消息（群聊未实现）
- 仅支持文本消息（图片/文件/卡片未处理）
- lark-cli event consume 1 小时超时（已实现自动重启，重启瞬间约 3~5s 不可用）
- 依赖 Agent 配合写 sideband 文件

## 📄 License

MIT
