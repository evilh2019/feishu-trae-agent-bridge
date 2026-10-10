# 飞书桥 → Trae 外部接入网关：架构与落地规划

> 目标：把 `feishu-bridge` 从「单一飞书接入」演进为 Trae 的**外部接入 + 增强平台**。
> **飞书降为第一个适配器（adapter），网关（gateway）成为中心**；唯一脆点（Trae 内部 API）被隔离在会话驱动层。
>
> 关联文档：[feishu-build-guide.md](./feishu-build-guide.md)（桥接实现、TC-01~TC-09）

## 〇、文档与用例同步纪律

- **每落地一步，必须同步更新**：本文档 §五 阶段状态、§七 用例结果。
- 用例编号**承接** build-guide 的 TC-09，从 **TC-10** 起。
- 代码改了但文档/用例没改 = 这一步未完成。

---

## 一、目标与三条铁律

出发点优先级：**稳定性 > 可扩展性 > 独立性**（独立性不能以牺牲稳定为代价）。

| 出发点 | 铁律 |
|---|---|
| 当前稳定性 | 只加不删、每步可 `Reload Window` 回退；先落「接口」再落「搬迁」；**绝不追 Trae 内部 API 的深度**，只用一个面 |
| 未来可扩展性 | 稳定接口 + 注册表；新增能力 = 新增模块，不改核心 |
| 功能独立性 | 三个**正交维度**互不知晓；一处故障不拖垮别处（一律 fail-safe） |

---

## 二、P0 现状基线

当前链路（v0.1.2，已跑通，**基线不动**）：

```
飞书消息 → lark-cli event consume（NDJSON stdio）→ 扩展 enqueueEvent/processQueue
        → handleFeishuEvent → icube.chat.sendToAgentNonBlocking → Trae Agent
        → Agent 写 sideband 文件 → 扩展 fs 读取 → lark-cli im +messages-send → 飞书
```

**已实测的脆点与死路**（决定架构边界）：

| 项 | 实测结论 |
|---|---|
| `icube.chat.*` | 无「读会话历史」API |
| `copyLastTurnDebugInfo` | 权限门控，不可用 |
| `icube.webview.sendCommand` | 带参会卡死扩展宿主 |
| `database.db` | SQLCipher 加密 |
| 回复通道 | 依赖 Agent 配合写 sideband 文件（LLM 依赖，可能丢） |
| Trae 升级 | 曾影响内部 API（`lark` 版本目录变化已有 TC-09 覆盖） |

> 结论：**会话驱动是全年唯一脆点**；平台化必须把它关进接口，其余按稳定接口拼装。

---

## 三、目标架构

```
维度A 传输(adapter)              维度C 增强(interceptor / hook)
 飞书 / HTTP / a2a / CLI…          召回 / 脱敏 / 附链接 / 落库…
        └──────────┬──────────────────────┘
                   ▼
           [ Gateway 关键扩展 ]      传输无关：注册表 + 生命周期 + 日志
                   ▼
        [ TraeSessionDriver ]        唯一脆点：icube + sideband
                   ▼
                Trae Agent
```

三个**正交维度**（互不知晓对方实现）：

- **A 传输（adapter）**：每个外部系统一个 adapter，自己管连接/收发/鉴权。
- **B 会话驱动（driver）**：把「一段文本交给 Trae、拿回回复」封装成一个接口。**唯一脆点**。
- **C 增强（interceptor/hook）**：只对「上下文」与「回复文本」做加工，不碰传输、不碰驱动。

---

## 四、稳定接口契约（先定死）

```js
// 1) 会话驱动：唯一与 Trae 内部 API 打交道处（脆点隔离）
TraeSessionDriver.send(text, { session }) -> Promise<{ reply, meta }>

// 2) 传输适配器：每接一个外部系统 = 一个 adapter
InboundAdapter { id, configure(cfg), start(ctx), stop() }
//   ctx.onInbound(peer, text) -> Promise<reply>   // 交给 Gateway 编排
//   ctx.reply(peer, reply)                        // 适配器自己回写

// 3) 入站拦截器（增强层，已实现）：只加"上下文"，不碰传输
InboundInterceptor: (text, ctx) -> Promise<string | ''>

// 4) 出站钩子（增强层，待实现）：只改"回复"，不碰传输
OutboundHook: (reply, ctx) -> Promise<string>
```

> `InboundInterceptor` 已于 P1 在基座落地：`registerInboundInterceptor(fn)` 经基座 `activate()` 的**返回值**暴露
> （⚠ VS Code 的 `extension.exports` 取 `activate()` 返回值，**不是 `module.exports`**；曾因只写 `module.exports`
> 导致增强扩展挂载失败，见 feishu-build-guide v0.1.3），在每条入站消息进会话前被 `await`，返回值前插到 `agentMessage`；异常一律捕获、fail-safe。
>
> P1 部署清单（本地 unpacked）：基座 `xiaot1.xiaot1-bridge` v0.1.3（`~/.trae-cn/extensions/xiaot1-bridge/`）+
> 增强 `xiaot1.xiaot1-bridge-enhance` v0.1.0（`~/.trae-cn/extensions/xiaot1-bridge-enhance/`，已登记进 `extensions.json`）。
> 公开仓库源码 `extension/extension.js` 已同步同一扩展点（不含任何 xiaot1 专属逻辑）。

---

## 五、阶段计划

| 阶段 | 内容 | 验收 | 回退点 | 状态 |
|---|---|---|---|---|
| **P0** | 现状飞书桥稳定运行 | build-guide TC-01~TC-09 全绿 | — | ✅ 基线 |
| **P1** | 基座暴露 `InboundInterceptor` + 独立增强扩展（经验库召回） | TC-10~TC-15 | Reload 回到 P0 | ✅ 完成（TC-11~14 运行时验证；TC-10/15 代码结构保证 ✅*） |
| **P1b** | 把通用扩展点同步进公开仓库源码 | 仓库与部署副本语义一致 | git 回退 | ✅ 已同步（`node --check` 通过） |
| **P2** | 基座内补网关概念：adapter 注册表 + `OutboundHook` + 每适配器生命周期/错误隔离；飞书逻辑**原位**改成"注册成内置 adapter" | TC-16~TC-18 | 只加不删，Reload 回退 | ✅ 完成（基座 0.1.4：网关块 + 内置 `feishuAdapter` + 出站钩子；TC-17 运行时验证；TC-16/18 代码结构保证 ✅*） |
| **P2b** | 固定话题：飞书会话按 `chat_id` 固定映射到 Trae session（每对话一个会话）；修复 `/new` 检测失效与「重置后被复用策略抢回」两个 latent bug，新增 `forceNew` 强制新建 | TC-25~TC-28 | 保留原单会话逻辑 / Reload 回退 | ✅ 完成（基座 0.1.5；三副本同步，`node --check` 通过） |
| **P2c** | 会话复用修复：去掉「策略 A 三种参数盲发 + 策略 B 复用当前面板」带来的**重复投递**与**串场**，改为「存档优先复用、全程单次发送、回读确认实际落点」；超时阈值 30 分钟 → 12 小时 | TC-25~TC-28 | 保留旧复用逻辑 / Reload 回退 | ✅ 完成（基座 0.1.6；三副本同步，`node --check` 通过） |
| **P2d** | 定位「超时无回复」根因：`sendToAgentNonBlocking` 只在**当前聚焦会话**里触发 agent，发往后台存档会话返回无 `sessionId`、消息被静默丢弃。改为「确认落点才复用，否则回退当前聚焦面板重发」；`/new` 与无面板时仍走新建 | TC-25~TC-28 | 保留 P2c 定向发送逻辑 / Reload 回退 | ✅ 完成（基座 0.1.7；三副本同步，`node --check` 通过） |
| **P3** | 抽出 `TraeSessionDriver`（icube + sideband 关进接口） | 飞书链路行为不变；Trae 升级回归 | 保留原函数、开关切换 | ⬜ 待做 |
| **P4** | 新增**第二个** adapter（HTTP 或 CLI）验证抽象 | TC-19 | 删新 adapter 即可 | ⬜ 待做 |
| **P5** | 物理拆分：飞书 adapter 独立扩展，基座彻底通用化 | 全量用例回归 | 保留合并版 | ⬜ 待做 |

**为什么这个顺序**：先「接口化」再「物理拆分」。物理拆分要动 `extensions.json`、Reload、可能撞沙箱（已踩），放最后才不伤稳定性。

---

## 六、边界与风险

- **能力 vs 传输**：给 Trae 加**能力**优先走 **MCP**（正规、稳）；本网关只解决**外部驱动会话**。
- **风险 1**：`icube.chat.sendToAgentNonBlocking` 随 Trae 升级变化 → P3 的 driver 隔离，届时只换一层。
- **风险 2**：sideband 依赖 Agent 守约 → 保留超时 + 重试（现状已有 `maxWait`）。
- **风险 3**：多扩展部署通道（沙箱限制）→ 「逻辑独立」先行，「物理独立」按需。
- **风险 4**：本地扩展（unpacked + 手改 `extensions.json`）在 Trae 升级/重装后可能丢失。
  - **真实风险面**：正常版本升级**不会丢**（Trae 程序 `D:\Trae\Trae CN\` 与用户数据 `C:\Users\yuanw\.trae-cn\` 分离）；会丢的场景 = 重装勾选「清除用户数据」/ Trae 重写 `extensions.json` 剔除无 metadata 的手工条目 / 换机 / 手动删 `.trae-cn`。
  - **已落地方案（方案 A）**：**源码正本** `e:\Trae\xiaot1-ext-src\`（`xiaot1-bridge` + `xiaot1-bridge-enhance` 各含 `extension.js`/`package.json`）+ **幂等部署脚本** `deploy.ps1`（校验源→备份 `extensions.json`→补目录→upsert 条目→`-Check` 只检不改）+ **自愈计划任务** `XiaoT-ExtensionGuard`（登录时 + 每日 09:05 跑 `deploy.ps1`，接现有 `XiaoT-MemoryHealthCheck` 机制）。
  - **注意**：注册计划任务需**管理员**，用 `register-guard-task.ps1`（`#Requires -RunAsAdministrator`）一次性执行；**已注册**（`XiaoT-ExtensionGuard`：登录时 + 每日 09:05）。

---

## 七、验收用例（承接 build-guide TC-09，从 TC-10 起）

> 状态列：⬜ 未验 / ✅ 通过 / ❌ 失败 / ✅* 代码结构保证（免运行时验证）。每步落地后回填。

### P1：基座扩展点 + 增强扩展

| 用例 | 场景 | 操作步骤 | 预期结果 | 日志关键点 | 状态 |
|---|---|---|---|---|---|
| **TC-10 基座点无副作用** | 未装增强扩展 | 仅升级基座 → Reload → 飞书发消息 | 行为与 P0 完全一致，不注入任何内容 | 基座对增强零代码依赖；`length===0` 跳过分支（已由 TC-14 观测到「前插 0 字符」） | ✅* |
| **TC-11 增强扩展挂载** | 装增强扩展并激活 | Reload → 执行 `XiaoT1 Bridge Enhance: Status` | 提示"已挂载到基座…" | `enhance.log`: `✅ 已挂到基座入站拦截器: xiaot1.xiaot1-bridge` | ✅ |
| **TC-12 召回前插命中** | 消息与库有匹配 | 飞书发「优化进展如何，让飞书正常的优化工程」 | 消息前被插入召回块，Agent 正常回复 | `bridge.log`: `入站拦截器: 1 个, 前插 465 字符`；`recall.jsonl` `src:"xiaot1"` `n:1` 返回 `cc1-registry_single_writer.md`(0.59) | ✅ |
| **TC-13 无命中不注入** | 短确认无匹配 | 飞书发「在吗」 | **不**注入任何内容，回复正常 | `bridge.log`: `前插 0 字符`；`recall.jsonl` 该条 `src:"xiaot1"` `n:0`（top1 0.474 < 阈值 0.59） | ✅ |
| **TC-14 拦截器 fail-safe** | 召回脚本挂/超时 | WSL 内临时改名 `exp_recall_xiaot1.py`（令脚本不存在）→ 发消息 | 消息仍正常进会话并回复；仅日志告警 | `enhance.log`: `[经验召回] 退出码 2 … No such file`；`bridge.log`: `前插 0 字符`；Agent 正常回复 182 字符 | ✅ |
| **TC-15 基座不依赖增强** | 增强扩展被卸载/挂载失败 | 停用增强扩展 → 发消息 | 飞书链路照常，不受影响 | 基座无 enhance 引用（仅注释）；挂载失败已在 P1 修复过程实际出现且基座不受影响 | ✅* |

### P2：网关概念（adapter 注册表 + OutboundHook + 错误隔离）

| 用例 | 场景 | 操作步骤 | 预期结果 | 日志关键点 | 状态 |
|---|---|---|---|---|---|
| **TC-16 适配器错误隔离** | 一个 adapter 抛异常/崩溃 | 代码结构验证（`startAdapter`/`stopAdapter` 各自 try/catch）；完整运行时验证随 P4 第二 adapter | 某 adapter 失败被隔离，其它 adapter 与主链路不受影响 | `bridge.log`: `❌ 适配器启动失败（已隔离）` / `⚠️ 适配器停止异常（已隔离）` | ✅* |
| **TC-17 出站钩子** | 注册 `OutboundHook` 改写回复 | 创建标志文件 `e:\Trae\feishu-bridge\outbound-hook.on` → 发飞书消息 → 删除标志文件 | 飞书收到回复末尾带 `[enhance-outbound-hook ✅]`；删除标志后恢复正常 | `bridge.log`: `[sendFeishuReply] 出站钩子: 1 个, 77 → 104 字符 (2ms)`；`enhance.log`: `[出站钩子] 命中 flag，adapter=feishu，原文 77 字符` | ✅ |
| **TC-18 适配器独立启停** | 命令面板停/启某 adapter | `XiaoT1 Bridge: Gateway: List Adapters` 查看 → `Gateway: Toggle Adapter` 停止 → 再列出 | 列出显示 `feishu(运行中/已停止)`；独立启停不影响进程 | `bridge.log`: `[gateway] startAll 完成` / `stopAll 完成` / 各 adapter running 状态 | ✅* |

### P2b：固定话题（按 chat_id 会话映射）

| 用例 | 场景 | 操作步骤 | 预期结果 | 日志关键点 | 状态 |
|---|---|---|---|---|---|
| **TC-25 同对话固定复用** | 同一飞书对话连续发多条消息 | 在同一 P2P 对话内连发「你好」「继续」 | 两条消息进**同一个** Trae session，上下文连续，不再每条新建话题 | `bridge.log`: `[Session] 保存对话 <chatKey> 的 session: <id>`；两次回复指向同一 sessionId | ⬜ |
| **TC-26 跨对话隔离** | 两个不同飞书对话 | 从另一对话（不同 `chat_id`）发消息 | 各自映射到**独立** session，互不串上下文 | `bridge.log`: 两个不同 `chatKey` 各自保存 session；`session_state.json` `chats` 含两个 key | ⬜ |
| **TC-27 `/new` 强制新建** | 对话内发重置指令 | 在某对话发 `/new` → 再发一条普通消息 | 收到「已重置对话」提示；下一条消息创建**全新** session（不被复用策略抢回旧话题） | `bridge.log`: `[Session] 重置 …（用户指令）`；`pendingNewChats` 命中 → 下条走新建分支 | ⬜ |
| **TC-28 超时重置** | 12 小时无消息 | 静置 >12 小时后发消息 | 自动重置该对话 session，新消息创建新 session | `bridge.log`: `[Session] 重置 …（超时 (12小时无消息)）` | ⬜ |

### P3/P4（待实现后细化）

| 用例 | 场景 | 预期结果 | 状态 |
|---|---|---|---|
| **TC-19 第二适配器** | 接入 HTTP/CLI adapter | 与飞书 adapter 并存、互不干扰 | ⬜ |
| **TC-20 driver 升级回归** | Trae 升级后 | 仅 driver 可能需调整；adapter/interceptor 不动 | ⬜ |

### 运维：扩展防丢失 / 恢复 / 自愈

> 对应 §六 风险 4。脚本正本在 `e:\Trae\xiaot1-ext-src\`；`deploy.ps1` 幂等，`-Check` 只检不改（退出码：0=已就位 / 1=有缺失 / 2=失败）。

| 用例 | 场景 | 操作步骤 | 预期结果 | 状态 |
|---|---|---|---|---|
| **TC-21 源码正本完整** | 校验正本 | 检查 `xiaot1-ext-src\` 下两个扩展各含 `extension.js`/`package.json`，且 `node --check` 通过 | 4 个文件齐全、语法无误 | ✅ |
| **TC-22 幂等部署** | 扩展已就位 | `deploy.ps1` 直接跑 | 输出 `OK：两个扩展均已就位`，`extensions.json` 不误伤其他条目 | ✅ |
| **TC-23 prune 自愈** | 条目被 Trae 剔除/目录缺失 | 删掉 `extensions.json` 中条目 → 跑 `deploy.ps1` | 自动补回 2 条，其余条目原样保留；`-Check` 检出缺失时退出码 = 1 | ✅ |
| **TC-24 自愈任务就位** | 计划任务已注册 | 管理员运行 `register-guard-task.ps1` 后 `Get-ScheduledTask -TaskName XiaoT-ExtensionGuard` | 任务存在（Ready），触发器 = 登录时 + 每日 09:05，动作 = `deploy.ps1 -LogDir ...` | ✅ |
