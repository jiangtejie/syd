# AI 对话助手页 · 设计与实现方案

> 状态:设计稿(待分阶段实现)| 相关模块:renderer AiChatPage / main aiChatService / ToolRegistry / provider stream
> 本文档是后续 P0/P1/P2 实现的唯一依据,实现与本文不一致处需回改文档。

## 1. 背景与目标

产品当前有「建议 Agent(单轮回复建议 + 3 个只读工具)」和「群问题监控(自动提取)」,但没有给客服/管理者一个**通用 AI 对话入口**。目标:

- 左侧导航「监控」上方新增 **AI** 菜单,页面形态参照 DeepSeek/主流对话应用:**左侧会话列表 + 中间对话框 + 顶部智能体选择 + 流式输出**;
- 对话可**绑定任意智能体**(复用 `ai_agent` 人设:名称/描述/风格/自定义守则);
- 对话引擎支持**工具/skill/MCP 接入**:
  - 内置 **skill**:只读业务能力包(查群问题、历史问题、团队名单、监控统计、客户档案、最近消息等);
  - **MCP**(P1):接入外部服务器能力(公司知识库 / ERP / 飞书等),作为同一工具协议的第二实现。

### 非目标(本期不做)
- 自动发送 / 代发消息(发送保持人工闸门);
- 多账号并行会话视图、会话云同步;
- 插件市场式分发 skill(仅内置 + MCP 动态能力);
- 知识库直答门户(知识能力统一走 MCP/skill)。

## 2. 总体形态

```
┌────── 左侧导航 ──────────────┐
│ 账号头像                     │
│ [AI]  ← 新增(监控上方)       │
│ 监控 / 看板 / 对话 / 客户/数据 │
│ … 设置(贴底)                │
└─────────────────────────────┘

AI 页(懒挂载,切走卸载或 keep-alive 可选):
┌ 会话侧栏(可折叠) ─┬ 主聊天区(DeepSeek 式) ────────────────────────────┐
│ + 新对话            │ 顶栏: 会话标题 … | 智能体▾ | (业务上下文灯) | ⋯    │
│ 会话1(标题/时间)    │ 消息流:                                            │
│ 会话2              │  用户气泡 / AI 消息(markdown+代码块+复制)            │
│ 会话3              │  · 工具调用卡片:「调用 skill:查询群问题 ✓ 结果摘要」  │
│ 删除/改名(hover)    │  · 停止生成 / 重新生成 / 复制 / 清空上下文           │
└────────────────────┼──────────────────────────────────────────────────┘
                     │ 输入框(多行;Enter 发送 Shift+Enter 换行) + 发送      │
                     └──────────────────────────────────────────────────┘
```

关键交互:
- **新对话**:不立即创建,首条消息发出时创建并自动命名(标题=首条用户消息前 24 字,可改名);
- **智能体切换**:只影响后续回复(历史已生成内容不回放);默认取全局默认智能体(与工作台一致),未配置时用内置空人设;
- **业务上下文**:不强制注入,由模型按需调用内置 skill(见 §7);
- 会话数据域:**绑定当前账号 wxid**;未连接微信时仍可纯聊天,业务 skill 返回“未连接账号”。

## 3. 架构分层

```
渲染端
  AiChatPage / AiChatStore(zustand,页面级)
    ├─ ChatSidebar(会话列表)      ChatMain(消息流+markdown+工具卡)   Composer(输入区)
    └─ aiChatApi(窗口 API):list/save/remove chat · send · stop · confirmTool
IPC(事件:主→渲染 `ai:chat:delta/status/error`,渲染→主 invoke `cs:aichat:*`)
主进程 aiChatService(每会话 Runner)
  ├─ 人设:由 agentId 读取 ai_agent(agentRepo)→ 组 system 消息
  ├─ Provider: stream(messages,{signal}) + abort(保留 complete 供旧链路)
  ├─ ToolRegistry(工具协议统一):
  │     { name, kind:'builtin'|'skill'|'mcp', desc, run(ctx,args)→string }
  ├─ ContextManager:多轮消息构建 + 窗口裁剪 + 工具结果收敛
  └─ 存储:chat_session / chat_message(新表)
内置 skill 集(§7)   MCP 管理器(P1,§8)
```

### 与现有代码的关系
- `src/main/services/ai/provider.ts`:**扩展** `streamChat()`,`complete()` 不动(建议链路继续使用);
- `src/main/services/ai/agentTools.ts`:**重构为 ToolRegistry + skills 目录**(保留 `SUGGEST_TOOLS` 语义给 suggest 用,或由 registry 派生同一份);
- `src/main/services/ai/agentLoop.ts`:协议复用思路,但对话 Runner 独立实现(多轮 + 流式 + 会话历史),**不**复用单轮 suggest 流程;
- 智能体列表复用 `agentRepo / cs:agent:list`,不新开通道;
- `WorkbenchPage` 增加 `'ai'`,App.tsx NAV_ITEMS 插入 `监控` 之前。

## 4. 数据模型(cs.db)

```sql
CREATE TABLE IF NOT EXISTS chat_session (
  id INTEGER PRIMARY KEY,
  wxid TEXT DEFAULT '',            -- 所属账号(空=未连接时通用会话)
  title TEXT NOT NULL,
  agent_id TEXT,                    -- 绑定的智能体(NULL=跟随全局默认)
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS chat_message (
  id INTEGER PRIMARY KEY,
  session_id INTEGER NOT NULL,
  role TEXT NOT NULL,               -- user|assistant|system(注入事实)|tool
  content TEXT NOT NULL DEFAULT '',
  kind TEXT DEFAULT 'text',         -- text | tool_call | tool_result | error
  meta TEXT,                        -- JSON:{tool,args,resultClip,agentId,reasoning?}
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_chat_msg ON chat_message(session_id, id);
```

- 会话列表按 `updated_at DESC`,消息按 `id ASC`;
- 渲染所需的「工具卡片」「错误」都以独立 message 行落库(kind 区分),避免解析正文;
- 无需重建会话历史:每次 send 把 DB 历史载入 ContextManager。

## 5. IPC 协议

渲染 → 主(invoke):
| channel | 参数 | 返回 |
|---|---|---|
| `cs:aichat:listChats` | wxid | `{chats}` |
| `cs:aichat:renameChat` | id,title | ok |
| `cs:aichat:removeChat` | id | ok(级联删消息) |
| `cs:aichat:messages` | id | `{messages}` |
| `cs:aichat:send` | `{wxid, chatId?, agentId?, text, tools:[names], context?}` | `{chatId, messageId}`(创建会话时返回新 id) |
| `cs:aichat:stop` | wxid,chatId | ok(Abort) |
| `cs:aichat:retry` | wxid,chatId,agentId | 重跑最后一次 user |
| `cs:aichat:confirmTool` | runId | ok(高危工具人工确认后放行) |

主 → 渲染(事件,`webContents.send('ai:chat', payload)`):
```ts
{ wxid, chatId, type:'delta', token }            // 流式增量正文
{ wxid, chatId, type:'tool',  tool, args, status:'start'|'done'|'fail', resultClip? }
{ wxid, chatId, type:'done',  messageId, usage? }
{ wxid, chatId, type:'error', message }
{ wxid, chatId, type:'status', text }            // 连接中/生成中/已停止
```
渲染端 AiChatStore 按 chatId 汇聚,断线重连后以 `messages` 全量对齐兜底。

## 6. Provider 流式与中断

`AiProvider` 增加:
```ts
streamChat(
  messages: ChatMsg[],                     // {role:'system'|'user'|'assistant', content}
  opts: { maxTokens?: number; signal?: AbortSignal; onToken:(t:string)=>void }
): Promise<{ finishReason?: string }>
```
实现要点:
- POST `/chat/completions`,`stream:true`;SSE 逐行解析 `data: {...choices[0].delta.content}`(兼容 `reasoning_content` 只计不吐或折叠为状态提示);
- 首个 400 且含 temperature 不支持 → 去 temperature 重试(沿用现有逻辑);
- 收到 `finish_reason=length` 且内容为空时,按现有“放大重试”策略最多补一轮(仅对非流式结果路径重放可简化为提示);
- `signal` abort 时主进程注册表 `activeRuns.set(runKey, controller)` 供 stop 使用;UI 显示“已停止”,已收内容保留。

**协议与流式的关系**:工具轮采用非流式子调用(模型输出简短 JSON 工具请求,无需逐字展示);**最终正文轮**使用 streamChat 向 UI 逐字输出。因此 send 的整体时序:
1. ContextManager 组消息 → 调模型(非流式,小预算 512)判断是否工具意图;
2. 意图=tool → 执行工具(内置本地 / MCP),以 `user` 角色回填结果 → 回到 1(工具轮上限 4);
3. 意图=正文 → 以完整 messages 发起 `streamChat` 直到结束。

## 7. 工具抽象与内置 skill(第一批)

统一接口(与现 agentTools.AgentTool 同构,迁移成本低):
```ts
interface ToolDef {
  name: string
  kind: 'builtin' | 'skill' | 'mcp'
  description: string                 // 拼进提示词,含参数 JSON 示例
  run(ctx: ToolCtx, args: Record<string, unknown>): Promise<string>
}
```
内置 skill 清单(全部只读、毫秒级、输出截断 4000 字):
| name | 说明 |
|---|---|
| `query_issues` | 跨群/按状态/严重度/复发查询问题库(替代现 search_issues 的泛化版) |
| `query_group_issues` | 指定群的问题清单(现 read_group_issues) |
| `list_team_members` | 团队客服成员名单(现成) |
| `monitor_summary` | 监控 KPI 汇总(待办/紧急/跟进超时/今日新增解决等,复用 monitorMetrics 同口径的 SQL 聚合,主进程实现) |
| `customer_lookup` | 按客户昵称/username 查画像与会话摘要(客户页派生逻辑的服务化) |
| `recent_messages` | 读取某会话最近 N 条消息文本(用于“他刚才在群里说了什么”) |
| `group_analyze` | 对指定群手动触发一次增量分析并返回结果(只读上游分析的唯一“写入”,标注 confirm) |

- **上下文注入**:只注入“可用工具列表与调用格式”;模型决定何时调用;tool 结果以独立消息行(`kind:'tool_result'`)或 `user` 回填二选一 —— 采用 **user 角色回填**(保证上下文一致性、实现简单),但 UI 额外存 kind 行用于渲染卡片;
- 高危险能力(未来可能出现的“写/发送”类)标注 `confirm:true`,需渲染端 `cs:aichat:confirmTool` 放行并 30s 超时。

## 8. MCP 接入(P1,占位设计)

> 依赖决策:**不引入 @modelcontextprotocol/sdk**;自实现精简客户端。

- 服务器注册表(设置页新增「MCP 服务器」管理):`ai_mcp_server(id, name, kind:'stdio'|'http', command/url, args, timeoutSec, enabled, createdAt)`(http 走 SSE/streamable JSON-RPC 子集);
- **stdio**:主进程按需 spawn(会话首次命中即拉起,空闲 10min 回收,异常自动重启一次后报错);与服务器走 **JSON-RPC 2.0 over stdio**(`initialize → tools/list → tools/call`),实现 MCP 规范子集(不实现 sampling/roots/completions);
- **http**:直接 fetch 同 JSON-RPC;
- 工具映射:`tools/list` 结果 → 注册为 `mcp:{server}:{tool}`,description 合并进可用列表;调用时校验超时/白名单(默认允许全部,但 `dangerous` 语义由服务器 tools 描述中标记 → 渲染端确认);
- 会话上下文不持久化到 MCP(每次 call 独立);
- 安全边界:所有 MCP call 输出截断;stdio 进程参数防注入(不接受自由参数,仅配置面板字段);默认不自动连接,需用户在设置中添加并启用。

## 9. 上下文窗口策略(第一版,不做总结压缩)

- 保留:system(人设)+ 最近 **40 条** 非 tool 消息 + 最近 **6 条** tool 结果摘要;
- 超窗按“丢最旧 user/assistant,保留 tool 对应主文”裁剪;单条 content >3000 字截断;
- 工具结果统一 `resultClip`(≤2000 字)入历史;
- 未来可升级:窗口到期自动生成一次摘要消息(kind:'summary')。

## 10. 渲染端组件与状态

- **AiChatStore**(新 store 或 AiChatPage 内部):sessions / activeId / messagesMap / streamingMap / toolCards / agentId / 连接状态;事件订阅汇聚 delta;
- **Markdown 渲染**:批准引入 `react-markdown + remark-gfm`;代码块轻量高亮(先 `pre > code` 主题化 + 复制按钮,不引 highlight 库);消息流中消息长文本优化(打字机按 delta 追加);
- 会话侧栏:新建(置顶激活)、hover 改名/删除(confirm)、未连接 wxid 显示“未连接账号”标识;
- 智能体选择:复用 `cs:agent:list`;顶栏胶囊展示当前人设与一句描述;
- 输入区:自适应高度 textarea、Enter 发送、发送中禁用并显示「停止」;
- 错误态:网络/额度/超时错误显示为错误行 + 「重试」。

## 11. 里程碑与验收

| 里程碑 | 内容 | 验收 |
|---|---|---|
| **P0-a 引擎** | provider.streamChat+abort;chat_session/message 表与 repo;ContextManager;aiChatService send/stop/retry(JSON 工具协议循环) | 控制台脚本或临时 IPC 可完成多轮带工具对话;abort 生效 |
| **P0-b UI** | NAV_ITEMS+页面骨架;会话 CRUD;流式渲染 markdown;工具卡;智能体选择;react-markdown 接入 | 人工对话体验接近 DeepSeek;切页/重启后会话仍在 |
| **P0-c skill 化** | agentTools → ToolRegistry;内置 7 个 skill;监控/群问题 skill 数据正确 | 在对话中“这个群有哪些待处理客诉”走 query_group_issues 返回正确 |
| **P1 MCP** | §8 自实现 stdio/http 客户端 + 设置页管理 + 确认机制 | 用本地 echo/mcp 示例服务器全链路打通 |
| **P2 打磨** | 标题自动生成、会话搜索/导出、用量审计、window summary | 按需 |

## 12. 风险与开放问题
- 推理模型流式内容可能仅在 reasoner 阶段后出现(UI 需兼容空 delta 长停顿,给“思考中”状态);
- 上下文窗口预算与工具轮成本:高频长会话 token 消耗,提供“清空上下文”按钮 + 会话级 token 预估(未来);
- MCP 无官方 SDK 依赖,协议子集随 MCP 规范演化可能需维护;
- 建议链路(`suggest`)保持现状,不与对话 Runner 混用,避免回归。
