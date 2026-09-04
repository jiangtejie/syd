# Pi(earendil-works/pi)集成调研与试点设计

> 状态:调研完成,试点设计待批准(批准后再写代码)
> 范围:仅评估“用 pi-agent-core/pi-ai 替换/并存我们自研的 agent 循环”,UI/存储/MCP/自定义工具保持不变。
> 信息来源:仓库与 packages/ai、packages/agent 两个 README(经云抓取,细节以实际 npm 包为准),标注未核实项见 §6。

## 1. 调研结论(三项事实)

| 问题 | 结论 | 出处/备注 |
|---|---|---|
| 许可证 | **MIT**(Copyright 2025 Mario Zechner) | LICENSE 文件;商用/再分发无碍(保留版权声明即可) |
| 支持任意 OpenAI 兼容端点? | **支持**:官方列出的通道包括 DeepSeek、Moonshot(Kimi)、Qwen、MiniMax、Groq、OpenRouter 等,**并明确覆盖 “Any OpenAI-compatible API: Ollama / vLLM / LM Studio…”**;另有 `createProvider()` + “OpenAI Compatibility Settings” + 动态 provider(`models.refresh`) | pi-ai README:Supported Providers / Dynamic Providers / Custom Providers |
| 推理类“无 tools”模型策略 | **重要约束**:pi-ai README 原文加粗声明“**只收录支持 tool calling(function calling)的模型**,agentic workflow 必需”。纯 reasoner 型(如 deepseek-reasoner)若无 function-calling 支持则不在其目录/不适用 | 需实测:DeepSeek chat(支持 tools)在列;reasoner 走不通 → 必须保留现有 JSON 协议循环做兜底 |

## 2. 事实库(试点设计依据)

- pi 是 TS monorepo,npm 库:`@earendil-works/pi-ai`(统一多 provider:模型目录/认证/stream/usage/thinking)、`@earendil-works/pi-agent-core`(stateful `Agent`:工具执行、事件流、before/afterToolCall、steer/follow-up、abort、会话态),另附 sqlite session-backends(可选,我们不用——已有 chatRepo)。
- pi-ai 事件(经 `models.stream(context)`):`text_delta`、`thinking_delta`、`toolcall_*`(含流式参数)、`done(reason)`、`error`;`s.result()` 拿最终消息;usage 含 token 与成本。
- agent-core 事件:`agent_start/end`、`turn_*`、`message_update(text_delta)`、`tool_execution_start/update/end`;`beforeToolCall` 可 `{block:true, reason}`(人工确认的天然落点);`continue()` 可做重试。
- 工具定义:`AgentTool{name,label,description,parameters:TypeBox,execute(…,signal,onUpdate)}`,参数经 TypeBox 校验;有 `terminate` 语义可跳过后续 LLM 轮。
- 无内置权限/沙箱(根 README 明示):容器化/授权边界由宿主负责 —— 与我们“发送人工闸门 + 工具确认”一致即可,不引入额外风险面。
- 版本节奏快(锁步 0.x、monorepo 高频提交),接入后 API 变动风险需用“适配层收口”对冲。

## 3. 与本项目现状的映射

| 我们已有 | pi 侧对应 | 试点处理 |
|---|---|---|
| `AiProvider.streamChat/complete`(自研 SSE) | pi-ai stream/complete(各 provider 实现) | 试点期**不动**现有 provider;pi 侧独立建 Models(读同一 app_config:ai.baseUrl/apiKey/model/enabled) |
| 自研 agent 循环(JSON 工具协议,~300 行) | pi-agent-core Agent 循环(原生 function-calling) | 试点“双轨”:模型支持原生 tools → pi;否则/失败 → 现有循环 |
| `skills.ts`/`customTools`/`mcp.ts` 的 `ToolDef{name,description,run}` | `AgentTool`(TypeBox schema + execute) | 写适配器 `toolDefToPiTool()`:description 透传;参数 schema 由 ToolDef 的 description 无法自动生成 —— 试点先给内置工具手写 TypeBox 参数,自定义 HTTP 工具按其 params 声明映射;MCP 工具先标记宽松 `Type.Record(Type.String(), Type.Unknown())`(损失参数校验,换取通用) |
| 高危工具人工确认(`confirm` + runId 通道) | `beforeToolCall` → `{block:true, reason}` | 确认 UI 复用现有 `toolStatus:'pending'` 卡片;阻塞后不置 terminate,允许模型补参或用户点确认后手动重发?设计:确认=放行一次(pi 侧无“挂起续跑”,采用“先 block 并记录 runId,渲染端确认后由宿主重放同一条 prompt”或“确认后允许 execute”二选一)——试点采用:**block + 提示用户手动重发**会打断流程;更优:pi 事件流下无法异步续跑,采用确认先行策略:`beforeToolCall` 遇到 confirm 工具先 emit pending 并 await 用户确认(本地 resolve),期间 pi 循环停在 tool preflight —— 需验证 pi 是否允许 async 挂起(阻塞事件循环),若不可行则退回 block+manual retry(试点记录) |
| `AiChatEvent(delta/tool/done/error/status)` | pi 事件序列 | 写 `piEventToAiChat()` 映射,`message_update.text_delta`→delta;`tool_execution_*`→tool 卡;`agent_end`→done;usage→附加 status |
| 存储 chat_session/chat_message + 窗口裁剪 | Agent 内部 messages/transformContext | 不动:消息仍走 chatRepo;每轮把 chatRepo 行转成 pi `Context.messages`(tool_result 已按 user 回填结构一致),pi 只在本轮内存中跑 |
| stop/retry | Agent.abort()/continue() | service 层按现有 runKey 控制 |

## 4. 试点设计(批准后实施,不改 UI/存储/MCP)

目标:在主进程加 `runner/piRunner.ts` 与现有 `chat/service.ts` 并存,通过 app_config 开关 `ai.agentEngine = 'pi'|'self'(默认 self)` 与**自动降级**接入同一 send 流程;UI 完全无感。

步骤:
1. 依赖:`npm i @earendil-works/pi-ai @earendil-works/pi-agent-core`(版本锁定);确认打包体积增量与 electron-vite main 构建兼容(tree-shaking 指引见其 README)。
2. `ai/providers/piFactory.ts`:读现有配置 → openai-compat 动态 provider(baseURL/Key/模型);失败信息原样透传。
3. `ai/chat/piAdapter.ts`:
   - `toolsToPi(skills/custom/mcp defs)`;
   - 事件桥(§3 映射);
   - confirm 桥(beforeToolCall 异步放行方案,先做可行性验证,失败退 block+manual);
   - `messagesToContext/contextToRows`(增量落库仍在宿主完成)。
4. `service.runTurn` 增加分支:`capability=modelSupportsTools(modelId)`(内置判定表:reasoner/纯思考名 → self;其余含 deepseek-chat 等 → pi;未知默认 self,人工可切)。
5. A/B 验收脚本化用例清单(见下),对照现有循环输出正确性与工具轮成本(usage 落库对比)。
6. 默认关闭(engine=self),验证通过后由用户决定切换默认。

验收指标:同一批用例(业务问答调用 query_issues/monitor_summary;自定义 HTTP GET;MCP echo;多工具并行;reasoner 无 tools 降级;stop 中断;确认工具)下:内容正确性一致、工具调用成功率 ≥ 现实现、reasoner 降级无回归、打包后 main bundle 体积增量记录在案。

## 5. 决策建议

- **值得试点**:MIT、TS 库级、事件流/usage/thinking 原生支持、官方覆盖 DeepSeek/OpenAI-compat —— 与本项目高度同构,长期可省去自维护循环。
- **试点前提(写入验收)**:① DeepSeek chat 在 pi 下工具调用可靠;② reasoner 无 tools 模型自动走 self 无回归;③ 确认工具的异步放行方案可行(否则该能力在 pi 路径受限)。
- **不做的事**:迁移 UI/存储/MCP/自定义工具;替换建议链路(suggest 单轮)不动。

## 6. 未核实项(试点第一步先查)
- 当前 npm 发布版本与 peer 依赖/Node 版本要求;
- “OpenAI Compatibility Settings”对自定义 baseURL 的确切参数(文档该节未抓全);
- deepseek-reasoner 在 pi 目录中是否存在(README 语义表明不收录,需实测);
- pi-ai/agent-core 对 Electron main(CJS/Node 22?)的打包兼容与体积实测;
- `beforeToolCall` 阻塞期间能否异步等待人工确认(源码/示例验证)。
