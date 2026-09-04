# AI 工作台 v1 设计（CipherTalk 优秀设计改良吸收）

> 目标:给客服产品加一个「AI 工作台」页——AI 用**标准 agent 循环**调用产品原生能力
> (微信数据/监控问题/客户/消息/团队/软件状态),配合**轻量 SKILL.md 知识**,写/执行类操作人工确认。
> 原则:**不自研 agent 循环/工具协议/模型适配**——循环、流式、工具 schema、动态工具组、多模型适配
> 全部用 Vercel AI SDK v5;自研只剩“业务适配器 + 确认桥 + 会话存储 + UI”。

## 1. 技术选型与新增依赖

| 依赖 | 用途 | 说明 |
| --- | --- | --- |
| `ai`(v5) | generateText/streamText/tool/zod/`activeTools`(动态工具组)/reasoning/usage | 主引擎 |
| `@ai-sdk/openai-compatible` | 接现有 `ai.baseUrl/model/key`(DeepSeek/Qwen/GLM/中转零改动) | provider 层 |
| `zod` | 工具参数 schema | 新依赖 |
| (v2 可选)`@modelcontextprotocol/sdk` | 把同一批能力对外挂成 MCP server | 本期不做,预留接口 |
| 复用已有 | react-markdown 渲染、toast、确认 UI 样式 | 零新增 |

注意:AI SDK 跑在**主进程**;electron-vite 需将 `ai/@ai-sdk/*` 置于 dependencies(打包进 node_modules)或 external 白名单,风险见 §9。

## 2. CipherTalk 改良吸收表

| CipherTalk 设计 | 处置 | 本方案落地形态 |
| --- | --- | --- |
| AI SDK `tool()+zod`、流式 chunk、generateObject | ✅ 吸收 | 工具层与流式直接使用 |
| `toolGroups`:常驻组 + 关键词路由 + `enable_tools` 显式解锁 | ✅ 改良吸收 | v1 先「常驻只读组」;v2 加关键词组与 `activeTools`/enable_tools |
| 固定能力菜单文本(跨轮不变,prompt-cache 友好) | ✅ 吸收 | system 固定段 = 规则 + 工具组菜单 + 技能目录,不随会话变 |
| Agent 跑在 utilityProcess + typed postMessage(run/chunk/progress/abort) | ⏳ 改良 | v1 引擎放主进程独立模块(超时+AbortController);v2 迁 utilityProcess |
| `toolApproval` 权限回调 + 权限建议 | ✅ 吸收 | 确认桥:`requestApproval(runId)` → `ai:wb` 事件 → 页面按钮(允许/拒绝,60s 超时拒绝) |
| compaction/aiCompaction 上下文压缩 | ✅ 改良 | 复用现有 `loadHistoryCtx` 思路(行数/字符预算 + generateText 摘要) |
| memory 分层(DB+importance+证据) | ❌ 不吸收 | 客服画像/事实记忆留 v2+ 单独评估 |
| SKILL.md 渐进加载(frontmatter 目录 → 全文注入) | ✅ 改良吸收 | 轻量版见 §7:文件级、无市场 UI、启用即注入(≤3 个/6k) |
| persona/voice/canvas/codeWorkspace/技能市场 | ❌ 不吸收 | 与客服无关或与你“做减法”方向冲突 |

## 3. 架构分层

```
L2 UI  工作台页(导航入口) + 设置页「工作台」tab(SKILL.md 管理)
        │ useChat 式事件订阅(ai:wb) / 确认按钮 / 停止
L1 引擎 services/ai/workbench/
        │ AI SDK 工具循环 + 确认桥 + 上下文预算/摘要 + 会话落库
        │ tools.ts: 产品能力 → tool()(zod) ; skills.ts: SKILL.md 扫描/注入
L0 产品能力(复用现有服务,零改动)
        issue/监控/客户/消息/团队/软件状态/IM 状态查询
```

数据模型:**复用 `chat_session`/`chat_message`**(工作台会话按当前 wxid 存储;IM 会话 wxid='' 天然隔离),不新建表。
技能存 `userData/skills/**/SKILL.md` 文件;启用集存 config(`wb.skills.enabled`,逗号名)。

## 4. 工具层(产品原生能力,只读)

全部 `tool()` 化,参数 zod 声明;**账号上下文由引擎注入**(wxid 不暴露给模型):
- 常驻只读组(7):`query_issues / query_group_issues / search_issue_history / monitor_summary / customer_lookup / recent_messages / list_team_members`
- 软件能力组(5):`software_status / data_scope / bi_stats / export_preview / im_channels_status`
- v1 无写工具(导出执行、状态变更、发送类留 v2,全部走确认桥)。

## 5. 引擎与确认桥

- 每轮:system(固定段:规则+能力菜单+技能目录;动态段:会话摘要) + 历史 → `streamText`(tools, stopWhen 由 SDK 控制);
- 工具执行:只读直接跑;危险工具 `execute` 内先 `await requestApproval()`——`ai:wb` 事件带 runId → 页面弹确认;60s 超时按拒绝返回提示文本;
- 停止:AbortController + `stopObject`;会话并发防重入 Map;
- 事件通道 `ai:wb`(delta/tool-start/tool-result/done/error/approval),字段沿用 `AiChatEvent` 风格 + sessionId。

## 6. 工作台 UI

- 导航新增「工作台」(监控之后);页面 = 会话侧栏 + 主区(流式 markdown、工具卡、确认按钮、停止/重试) + 顶部绑定账号提示;
- store `stores/workbenchChat.ts`(借鉴原 aiChat store 的事件/缓冲/工具卡模式);
- 设置页新增「工作台」tab:SKILL.md 列表(名称/描述/启用开关/打开目录),以及模型提示(建议非思考型模型)。

## 7. 轻量 SKILL.md(改良自 Claude Code/CipherTalk)

- 目录:`userData/skills/<name>/SKILL.md`;frontmatter 必填 `name`/`description`(可选 `allowed-tools`);
- 校验:纯 markdown、≤32KB、frontmatter 合法;**无任何代码执行**;
- 注入:启用技能(≤3 个)全文拼入 system 固定段(总量 ≤6k),未启用的仅出现在“技能目录”一行;
- v2:渐进披露(目录 → 模型显式 `use_skill` 再注入)与关键词触发;
- UI 无市场/无安装向导:仅列表+开关+“打开技能目录”按钮。

## 8. 分期落地

- **v1(本次)**:依赖接入 + `workbench/` 引擎(SDK 工具循环、确认桥、预算/摘要、事件) + 12 个只读工具 + SKILL.md 扫描/注入 + 工作台页 + 设置「工作台」tab + 门禁(prettier/tsc/eslint/build);
- **v2**:utilityProcess 隔离、关键词工具组 + `activeTools`/enable_tools、MCP server 对外、导出/发送等写操作(确认)、客服画像记忆。

## 9. 风险与对策

1. **AI SDK 打包**:主进程 CJS 环境需确认 electron-vite 对 `ai`(ESM)的 external/打包策略;必要时 main 侧用 dynamic import 且把依赖列入 electron-builder 的 files;
2. **reasoner 模型**:DeepSeek-R1/GLM-思考 的 tools 支持不稳定 → 工作台默认推荐非思考模型;检测到思考模型时给 UI 提示;失败时返回可读错误(不自研第二条文本协议,保持薄);
3. **网关 tools 兼容**:已有 `ai.nativeTools` 开关与降级经验;工作台工具失败信息直接回填模型,不让异常中断会话;
4. **确认桥**:只读工具不弹确认,弹窗频率低;超时即拒绝,不阻塞会话。

## 10. 验收口径(v1)

1. 新建工作台会话问“今日问题概览/某客户资料” → 常驻只读工具直接回填且无确认弹窗;
2. 工具执行展示于工具卡(名称/参数/结果/耗时/token);停止按钮可中断流式;
3. 放一个 SKILL.md(话术规范)启用后,问相关问题时回答口径按 SKILL 内容;停用后立即不注入;
4. 未绑定账号时业务工具返回礼貌占位(沿用 needsWx 语义),软件能力仍可用;
5. 会话历史复用 chat 表,IM 会话与工作台会话互不串扰。
