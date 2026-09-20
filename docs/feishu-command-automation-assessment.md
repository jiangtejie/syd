# 飞书下指令 → 客户端自动执行:能力盘点与差距评估

> 状态:**评估稿(2026-09),未改代码**。目标:把软件自身能力做成 Agent 可调用的技能/工具,
> 最终能在飞书上发一条指令,让客户端自动把任务做完。
> 事实来源:本仓库代码(工具注册表、IM 渠道、审批桥、schema)。
>
> **失效项(2026-09 追加)**:「营销域并入统一注册表」一节及全文涉及的 `growth_*` 能力已随营销模块
> **整体下线**失效(`ai/cap/registry.ts` 的 `growth` 组已移除);其余结论仍然有效。

## 0. 结论

| 问题 | 结论 |
| --- | --- |
| 链路要重搭吗 | **不用**。骨架已通:飞书消息 → 本地会话 → 客服 AI 引擎 → 工具 → 回复 |
| 缺的是什么 | **可控性 + 工具面 + 任务化 + 回执**四件事 |
| 最大冲突 | 刚做的「仅推送(不接收)」与"飞书下指令"**互斥** → 需要第三档:**只收白名单内同事的单聊,不收任何群消息** |
| 最该马上修的 | 接收白名单**当前形同虚设**:`allowUser()` 只在"绑定了微信业务账号"时才生效,未绑定时任何能私聊机器人的飞书用户都能下指令 |
| 结构性债 | 三套工具注册表(`chat/skills.ts` / `cap/registry.ts` / `growth/ai/growthTools.ts`)割裂;工作区工具在飞书会话里**拿不到** |

## 1. 现状:链路已经有什么(代码事实)

| 环节 | 现状 | 位置 |
| --- | --- | --- |
| 接收 | 飞书长连接 → `im.message.receive_v1`;私聊全响应,群聊需 @ 机器人 | `im/feishuService.ts onReceive` |
| 准入 | 白名单 `allowUsers`,**但仅当绑定了微信业务账号时判定**`(!rt.businessWxid \|\| allowUsers.length===0 → true)` | `feishuService.allowUser` |
| 会话映射 | 外部聊天 → 本地 `chat_session`(`im_chat_map`),独立上下文 | `im/sessionBridge.ts` |
| 引擎 | 复用客服 AI 引擎(ReAct + 工具循环 + 审批) | `ai/chat/service.ts` |
| 工具装配 | 能力注册表按会话挂载:L1 微信业务绑定即默认挂载;L2 软件/云文档需 `list_capabilities`→`mount_capability` | `ai/cap/registry.ts`、`cap/mounts.ts` |
| 审批 | 写工具 → 桌面审批条;飞书侧回复"确认"同样可批(`feishuConfirm`) | `ai/workbench/approval.ts`、`feishuService` |
| 回执 | 纯文本回复(Markdown→纯文本降级 + 3000 字分片) | `feishuService.sendTextReply` |
| 忙碌 | 会话忙时新消息进队列(覆盖式只留最新) | `feishuService.pendingQueue` |

**现有工具盘点(统一注册表 28 个 + 营销 11 个)**：

| 域 | 已有工具 | 缺口 |
| --- | --- | --- |
| 微信业务(L1,8) | query_issues / query_group_issues / search_issue_history / list_team_members / monitor_summary / customer_lookup / recent_messages / **send_message(写·审批)** | **操作类全缺**:标记已解决/搁置/指派跟进人/改严重度、批量处理;客户备注/标签;会话级操作 |
| 软件能力(L2,6) | software_status / data_scope / bi_stats / im_channels_status / memory_view / export_preview | 只有"看",没有"动":开关注入、复位熔断、切换监控、备份/清理 |
| 工作区(12) | workspace_list/read/search/file_info/write/mkdir/delete、csv_read/append、xlsx_preview/write、site_scaffold | **飞书会话完全用不到**(未进 `cap/registry`,只在工作台页的 `workbench/tools.ts`);无"飞书会话绑定工作区"入口 |
| 飞书云文档(3) | lark_base_tables / lark_base_records / lark_doc_read(只读) | 写回记录、电子表格、附件下载 |
| 核心元技能(3) | list_capabilities / mount_capability / unmount_capability | 缺 `/help` 面向**用户**的能力说明 |
| 营销(11) | 素材读取/门店/生图/封面/标题正文改写/产出/导出 | 只存在于营销 AI 工作台,**IM/飞书入口触达不到** |

## 2. 差距清单(按"要能自动完成任务"倒推)

### A. 可控性(前置,必须最先解决)

1. **白名单失效**:未绑定微信账号时白名单不生效 → 任何飞书用户都能遥控客户端(当前默认状态)。
2. **群消息**:群里 @ 就响应 → 与"不接收外部群消息"冲突。需要接收策略:**不收 / 只收白名单私聊 / 全收**,默认第二档。
3. **无身份分级**:谁能查、谁能写、谁能发微信消息,目前一刀切。
4. **无指令审计**:缺 `im_command_log`(发送人 / 原文 / 会话 / 触发工具 / 结果)。

### B. 工具面(把软件能力变成可调用工具)

- 补"操作类"工具(上面表格右列),写操作统一 `confirm` 标记 → 走既有审批桥;
- 把 `wsTools` 与 `growthTools` 纳入统一注册表(按 scope:wechat / software / workspace / cloud / growth),这样飞书指令也能触达工作区与营销能力;
- 工作台页已具备的证据编号/预算/压缩机制,IM 路径没有 → 建议共用同一装配层,避免"同一指令在不同入口表现不同"。

### C. 任务化(长任务)

现状:一轮对话最多 10~12 步工具调用、同步等待、超时即失败。缺:

- 任务实体(创建/状态/进度/结果/取消)、异步执行、断点续跑、超时重试、幂等;
- 后台完成后的**主动回执**(可直接复用刚做的 `sendImText`);
- 定时/触发型任务(可复用 `report/scheduler`、`growth/scheduler` 骨架)。

### D. 指令入口与回执

- 现在:消息文本**直接当提示词** → 无 `/命令`、无参数校验、无"先给计划再执行";
- 回执:只有最终文本;缺"已开始 / 进度 / 完成 / 失败"的结构化回执,缺交互卡片按钮确认;
- **用户不知道能下什么指令** → 需要 `/help`(直接复用 `list_capabilities` 的目录文本,按当前会话挂载态生成)。

### E. 一致性/体验

- IM 会话无工作区、无模型/重试入口;
- 失败只有一句错误文本,无"为什么失败 + 怎么改";
- 两套 prompt 与预算(工作台 vs IM)长期分叉。

## 3. 建议路线

| 阶段 | 内容 | 预估 |
| --- | --- | --- |
| **P0 让"飞书下指令"安全可用** | ①接收策略三档 + 修白名单(默认只收白名单私聊、拒群)②白名单管理 UI(用组织联系人挑人)③`/help` 能力清单回执 ④指令审计落库 | 1~3 天 |
| **P1 工具面补齐** | ⑤统一注册表(纳入 wsTools/growthTools,按 scope)⑥补操作类工具(问题状态/指派/导出/客户备注),写操作接审批 ⑦飞书会话可选绑定工作区 | 3~6 天 |
| **P2 任务化** | ⑧任务实体 + 队列 + 进度回执 + 取消(`/tasks`)⑨定时/触发任务 ⑩交互卡片确认 | 5~10 天 |
| **P3 治理** | ⑪身份分级(查/写/发三档)⑫审计查询页(任务中心已随 P2 落地) | 1~2 天 |
## 3.8 P3 落地:身份分级 + 审计查询(2026-09)

| 项 | 实现 |
| --- | --- |
| 权限档位 | 新模块 services/ai/cap/tiers.ts:viewer(只读)< operator(可写业务数据)< admin(含代发微信)。send_message 需 admin;任何写类能力(isWriteCap)需 operator;其余只读 |
| 档位来源 | 飞书:发送人命中权限名单取其档位,白名单内未列出默认 operator,名单外(全收模式下的陌生人)默认 viewer;ClawBot:同上(白名单为空视为不限制,默认 operator) |
| 强制点 | ①系统提示的工具清单按档位裁剪 ②native function-calling 的 schemas 同样裁剪(越权工具根本不出现在可选列表)③执行前二次拦截(覆盖自动挂载路径),提示「当前飞书账号权限为 X,不能执行需要 Y 的操作」 |
| /help 裁剪 | 能力目录按发送人档位过滤,只展示其可用能力,标题显示当前权限档位 |
| 名单管理 | 设置 → IM 渠道 → 编辑飞书账号 → 「命令权限名单」:每行 ou_xxx 或 ou_xxx=viewer|operator|admin;账号列表显示名单条数 |
| 审计查询页 | 设置 → IM 渠道 → 「飞书指令审计」:最近 50 条入站记录(kind=指令/消息/被拒、发送人、文本摘要、状态、耗时、触发工具、错误),10 秒刷新 —— 被接收策略拦下的消息同样留痕 |

本地入口(工作台页/对话页)不受档位限制(tier=undefined 视为不限制),保持原有能力。
## 3.9 自审后的清理(2026-09,零行为变更)

| 项 | 处理 |
| --- | --- |
| 分层倒置 | cap/registry.ts 曾 import ../workbench/wsTools → 已 git mv 到 cap/wsTools.ts,依赖方向理顺 |
| 权限缓存泄漏 | dropSessionCapTier 导出却无人调用 → 会话删除两处补上(与 mounts.dropSession 同一处) |
| 信任边界 | 权限档位此前只在渲染层校验 → imRepo 归一(ou_ 前缀 + 三档白名单) |
| 重复实现 | lark/api.ts 的第三份 call() → 统一复用 client.larkCall;通讯录选择器两处 ~166 行 → 抽 ContactPicker 组件 |
| 引擎重复 | chat/service.ts 两条协议通道各写一遍 approval/tier 判定 → 抽 guardToolExec();**顺带发现并修掉 native 通道此前完全没有档位校验**(只靠 schemas 裁剪兜底) |
| 过渡字段 | pushOnly 从 ImChannelAccount/Input 移除(仅保留老库读取兼容),前端统一用 receiveMode===off |

净效果:ImPage 722→671、FeishuNotifySection 469→354、新增共用 ContactPicker 132;两处真重复(调用包装、联系人选择器)与一处**安全缺口**消除。
## 3.10 技术与基线清理(2026-09,零行为变更)

**A. 基线 lint**:全仓 52 errors → **0 errors**(95 个既有 prettier 格式 warning 保留,`npm run lint` 现退出 0)。
修法:scripts/ 探针脚本纳入 eslint ignores;keyStore 用行类型替代 any;wechat/content 与 decrypt 用 unknown/instanceof 收敛;
wxService/analyzer 补返回类型;schema 的动态行取值保留 any 并加说明豁免;AttachmentViewer 的两个解密 hook 改为模块私有;
两处 set-state-in-effect 按仓库既有模式加理由豁免。

**B. 记账项**

| 项 | 处理 |
| --- | --- |
| ① 表合并 | im_command_log + im_task → **im_audit**(一条入站 = 一行,任务生命周期挂同一行);启动时幂等迁移(im_task 带 id 先入、im_command_log 补入,单表失败只记日志、标志照置避免反复重试);老表保留不删 |
| ② 面板去重 | 抽 useAuditPolling(轮询取数)+ AuditRowItem(行渲染)+ fmt 工具;两个面板各 150 行 → 55/57 行,共用 19+58 行 |
| ③ 命令抽取 | 新增 feishuCommands.ts(205 行):/help /tasks /task /cancel 与依赖注入接口(deps 由 feishuService 注入回复/去表情/日志/审计收尾);feishuService 1199 → **1039** 行 |
| ④ 类型收敛 | shared/types.ts 新增 ImAuditEntry / FeishuNotifyTargetInfo / FeishuNotifyConfigView / FeishuCredentialView / FeishuContactUser / FeishuContactScopeView / FeishuChatView;imAuditRepo、preload、渲染端共用同一份(preload 的 listTasks/listAudit 两个手抄接口合并为 listAudit(limit, onlyTasks)) |

IPC 收敛:cs:feishu:tasks:list 取消,统一为 cs:feishu:audit:list(limit, onlyTasks)。
## 4. 本轮交付与验收(交接)

### 交付范围

| 阶段 | 内容 | 状态 |
| --- | --- | --- |
| P0 | 接收策略三档(off/allowlist/all)+ 白名单 fail-closed + /help + 指令审计 | 已落地 |
| P0 | 写工具(resolve/stall/assign issue)+ 统一权限模式(人工审批/完全访问/只读)作用于 AI 页与飞书链路 | 已落地 |
| P1 | 统一工具注册表(工作区 12 项入册、工作台从注册表派生)+ 默认工作区 | 已落地 |
| P2 | 任务化:任务实体 + 进度回执(20s/60s)+ /tasks /task /cancel + 桌面任务中心 | 已落地 |
| P3 | 身份分级(viewer/operator/admin,三点强制)+ 桌面审计查询页 | 已落地 |
| 附带 | 飞书云文档只读工具、飞书告警推送、仅推送模式、WorkbenchChatPage「↓最新」修复 | 已落地 |
| 清理 | 分层倒置/缓存泄漏/信任边界/重复实现/native 档位缺口;基线 lint 52 errors → 0;表合并与类型收敛 | 已落地 |

### 自动化验证(已跑通)

- `npm run typecheck` ✅ / `npx eslint .` **0 errors**(95 个既有格式 warning)✅ / `npx electron-vite build` ✅

### 需要你在应用里手测的清单

1. **启动迁移**:首次用新构建启动,`logs/app-*.log` 应出现「im_audit 迁移完成:并入 N 条历史记录」(N=0 也正常);无该日志且无报错=标志已置位。
2. **接收策略**:设置 → IM 渠道 → 编辑飞书账号 → 接收策略选「只收白名单内同事的私聊」→ 白名单加自己 → 保存;列表应显示「只收白名单私聊」。
3. **指令闭环**:飞书发 `/help` → 收到能力清单(标题含你的权限档位);发一条真实指令 → 桌面「飞书任务」出现 #N 排队中→执行中→已完成;`/tasks`、`/task N`、`/cancel` 各试一次。
4. **审计**:桌面「飞书指令审计」应能看到上述记录;另用一个不在白名单的飞书账号发消息 → 应被拒且审计里出现「被拒」。
5. **权限分级**:把某同事设为 `=viewer` → 其 `/help` 不应出现写类能力;把「工具审批策略」切到「完全访问」→ 写操作应直接执行不再询问。
6. **工作区**:设置 → AI 助手 → 默认工作区选一个空目录 → 飞书发「把 XX 整理成文件放到工作区」→ 应能落盘(写操作按审批策略)。
7. **基线**:`npm run lint` 现在应退出 0(此前因 52 个错误退出 1)。

### 未提交

本轮所有改动**未提交**,工作区即完整改动集(原工作区在本轮开始前是干净的)。提交前建议先跑一遍上面的手测清单。

### 未做(可选后续)

- 营销域 13 个工具并入统一注册表(需先把 AI SDK `tool()` 重写为 `ToolDef`,并把「当前营销任务」绑定到会话);
- ~~飞书交互卡片按钮确认(替代「回复确认」文本)~~ → **已落地(2026-09,见 §3.8)**;
- 组织联系人数据权限放开后,权限名单/白名单可直接从通讯录勾选(代码已就绪,受平台数据权限限制);
- 95 个 prettier 格式 warning 的全量格式化(会产生较大 diff,建议单独一轮)。
至此 P0/P1/P2/P3 全部落地;剩余为可选增强:营销域工具并入统一注册表、桌面端取消任务、交互卡片确认。
## 3.7 P2 落地:任务化(2026-09)

| 项 | 实现 |
| --- | --- |
| 任务实体 | 新表 im_task:account/chat/session/发送人/标题/状态(queued→running→done|failed|cancelled)/进度/结果/错误/起止时间;每个非指令消息 = 一个任务 |
| 生命周期 | handleInbound 建任务 → drainInbound startImTask → 工具事件实时写进度 → 完成 finishImTask(done, 结果全文);超时/空闲等待超时 → failed |
| 进度回执 | runAiTurn 内 5s 轮询:超过 20s / 60s 且已有工具调用时,各回一条「⏳ 仍在处理(已 Ns):已完成 查询问题、监控概览」,最多 2 条防刷屏 |
| /tasks | 本会话最近 8 条任务:#id [状态] 耗时 标题 · 进度/错误 |
| /task <id> | 单条详情:指令、耗时、进度、错误、结果(≤1200 字) |
| /cancel | /cancel · /取消 · /stop:停引擎 + 任务置 cancelled;自然语言「停止」同样会收尾任务 |
| 孤儿防护 | 队列覆盖式只留最新一条 —— 覆盖前把上一条的审计行与任务收尾(标记「被新指令取代」),不留永远「排队中」的记录 |
| 桌面任务中心 | 设置 → IM 渠道 → 「飞书任务(指令执行记录)」:最近 20 条,状态/耗时/进度/结果摘要,5 秒轮询(只读;取消仍在飞书侧 /cancel) |

/help 已补上指令说明(能力清单 + /tasks + /task · 取消方式 + 写操作审批口径)。
至此「飞书下指令 → 异步执行 → 进度回执 → 可查可取消」闭环完成。

## 3.5 落地情况(2026-09,P0 + 写工具已实现)

已按确认口径实现:**只收白名单私聊 + 指定 open_id 名单 + P0 四项 + 写操作走全局权限模式**。

| # | 项 | 实现 |
| --- | --- | --- |
| 1 | 接收策略三档 | `im_channel_account.config.receiveMode`:`off`(仅推送,不建长连接)/`allowlist`(只收白名单私聊,群消息一律拒)/`all`(私聊全收 + 群 @);历史 `pushOnly` 自动映射为 `off` |
| 2 | 白名单 fail-closed | `feishuService.admitInbound`:allowlist 模式下白名单为空 = **拒绝全部来源**;群消息在 allowlist 下无条件拒绝;`all` 模式下白名单非空时同样过滤(修掉了"仅绑定业务账号才生效"的旧行为) |
| 3 | 白名单管理 UI | 设置 → IM 渠道 → 编辑账号:接收策略下拉 + 「接收白名单(open_id)」+ 「读取组织联系人」一键挑人(通讯录无权限时可直接粘贴 `ou_…`) |
| 4 | `/help` 能力清单 | 飞书里发 `/help`(或 `/帮助`/`/能力`/`help`)→ 直接回当前会话可用能力目录(不进 LLM) |
| 5 | 指令审计 | 新表 `im_command_log`:`kind=command/message/rejected`、发送人、chat、文本、状态、耗时、工具、错误;被拒消息也留痕,便于排查"为什么没反应" |
| 6 | 写工具 | `resolve_issue` / `stall_issue` / `assign_issue`(`confirm:true`,已注册进 L1 业务能力与工作台工具组) |
| 7 | 统一权限模式 | `approvalDecision()` 从审批桥导出;客服/IM 引擎(**两条协议通道**)接入 `allow`(完全访问直通)/`deny`(始终拒绝拦截)/`ask`(人工确认);工作台引擎改为按 `def.confirm` 判定 |
| 8 | 审批文案 | 设置 → AI 助手 → 工具审批策略改为「**人工审批** / **完全访问** / 只读」,并说明同时作用于 AI 页与飞书·IM 链路 |

行为变更提醒:飞书里的写操作在「人工审批」模式下会先在会话内发确认提示(回复「确认」执行),「完全访问」模式直接执行。

未做(P1+):任务实体与进度回执、交互卡片确认、身份分级、任务中心 UI;营销域工具尚未并入统一注册表(原因见 §3.6)。
## 3.6 P1 落地:统一工具注册表(2026-09)

| 项 | 实现 |
| --- | --- |
| 工作区能力入册 | cap/registry.ts 新增 workspace 组与 WS_CAPS(12 项:列/读/搜/信息 + 写/建目录/删 + CSV 读/追加 + Excel 预览/写出 + 静态建站);resolveCapDef 增加 findWsTool |
| 飞书侧可用 | 注册表即目录:/help 会列出工作区能力;模型直接调用未挂载能力时引擎会**自动挂载后执行**(既有渐进式守卫),无需两跳协议 |
| 默认工作区 | 新增 config wb.defaultWorkspace(设置 → AI 助手 → 默认工作区,支持目录选择);wsTools.rootOf 回退顺序:**会话绑定目录 → 全局默认工作区 → 提示去配置**,使飞书/ClawBot 这类没有工作台界面的会话也能读写文件 |
| 写操作审批统一 | 工作区 6 个写类工具打上 confirm:true → 走审批桥,按「工具审批策略」(人工审批/完全访问)判定;registry.isWriteCap() 作为统一判定入口 |
| 消除重复清单 | workbench/tools.ts 删掉自己那份 4 组硬编码清单,改为从注册表派生(workbenchToolNames / workbenchToolGroups)→ **新增能力只改注册表一处** |

行为变化:工作台页的工具集现在完全跟随注册表(停用项 cap.disable 对工作台页同样生效;软件能力多出 memory_view)。

### 营销域并入统一注册表(2026-09,**已落地**)

原判断:营销工具(growth/ai/growthTools.ts,13 个)是 **AI SDK tool() + GrowthToolCtx**,与客服侧 ToolDef 不同构,合并要先重写。本轮按这个思路落地:

| 层 | 文件 | 内容 |
| --- | --- | --- |
| 元数据(纯数据,零依赖) | `growth/ai/toolMeta.ts` | 13 个能力的 name/oneLine/when/confirm/needsContent·needsStore·needsTask/参数声明 —— **注册表与实现共用这一份**,并可离线自检 |
| 实现(ToolDef) | `growth/ai/growthToolDefs.ts` | 13 个 `ToolDef`;工具体与原实现逐字一致,仅机械改写:`ctx.contentId/taskId/storeId` → `contentIdOf(args)/taskIdOf(args)/storeIdOf(args)`(默认值由 `growthToolDefs(defaults)` 注入),`approve(...)` 由 `confirm: true` 取代 |
| AI SDK 适配 | `growth/ai/growthTools.ts` | 只做三件事:注入当前任务默认值、把 `confirm` 接到审批桥(120s,与工作台同一套)、保留 `itemBrief/storeBrief` 导出。**营销页行为不变** |
| 注册表 | `ai/cap/registry.ts` | 新增 `growth` 组(目录行 `营销能力`)、`findGrowthTool`、并入 `resolveCapDef`;工作台分组菜单同步列出该组 → 营销能力现在可从**任意会话按需挂载**(飞书/工作台/营销页同一份实现) |
| 参数能力扩展 | `ai/chat/skills.ts` + `ai/toolSchema.ts` | `ToolParamDecl` 支持 `enum/number_array/string_array/json`;zod 适配层抽成共享模块(此前只写在工作台里,营销域只能自己再声明一遍) |
| 契约自检 | `scripts/tool-registry-selftest.mjs` | `npm run test:registry`:13 个能力/命名唯一/目录行齐全/写类必须 confirm/参数必须有说明/枚举必须有可选项/上下文依赖与参数一致 —— 防「漏登记」与「写类被当只读」这两类老坑 |

> 先前的说明(留档):营销工具是 AI SDK tool() + GrowthToolCtx(sessionId/taskId/contentId/storeId),与客服侧 ToolDef 不是同一形态,且强依赖「当前营销任务」上下文——飞书私聊里没有任务,直接暴露会得到一堆无参数可用的工具。并进来需要两步:

1. 把 13 个 growth 工具从 tool() 重写为 ToolDef(参数声明 + run),约 1 天;
2. 给会话增加「当前营销任务」绑定(类似工作区绑定),或在工具内做任务选择(growth_list_tasks → 选任务)。

~~在此之前,营销能力仍只在 营销 → AI 工作台 内可用。~~ → **本轮已并入注册表(见上表)**:任意会话可按需挂载 `growth_*` 能力;
营销页仍是主入口(带当前任务上下文),其它入口需显式传 `contentId`(缺上下文时工具返回可行动提示)。

## 4. 需要拍板的决策

1. **接收策略**:只收白名单私聊(推荐)/ 全收 / 保持不收;
2. **谁能下指令**:绑定微信业务账号的会话 / 指定 open_id 名单 / 全部同事;
3. **写操作边界**:AI 能否直接标记问题已解决、直接发微信消息(现有审批是否保留、是否分级);
4. **回执渠道**:原会话回复 / 额外推送到指定群或人。

## 5. 风险

| 风险 | 说明 | 缓解 |
| --- | --- | --- |
| 越权遥控 | 白名单失效 + 客户端能发微信消息 = 任何飞书用户可代发 | **优先修白名单**,默认不接收陌生来源 |
| 误操作 | 操作类工具一旦放开,AI 可能误改业务数据 | 写操作一律审批 + 幂等 + 审计 |
| 上下文膨胀 | 工具数量上升挤压历史预算 | 沿用注册表的"目录 + 按需挂载" |
| 双引擎分叉 | 客服/营销两套引擎导致同一指令表现不一致 | P1 统一装配层 |
| 群消息泄漏 | 群里 @ 即响应会把内部数据暴露给外部群成员 | 默认拒群,只开私聊白名单 |

## 3.8 交互卡片确认(2026-09,已实现)

写类工具在飞书会话里挂起等待人工确认时,此前只发一条「回复「确认」执行」的文本。本轮改为**按钮卡片**,
文本方式保留为兜底(卡片发不出去时自动回落)。

| 层 | 文件 | 内容 |
| --- | --- | --- |
| 卡片构建/解析(纯函数) | `src/main/services/im/cards.ts` | `approvalCard({toolName,args,runId,operatorOpenId})` 生成「确认执行/取消」两个按钮;`parseApprovalAction(value)` 认领本卡片(动作标识 `tool_approval`);`actionValueOf` / `operatorOpenIdOf` 宽松提取回调字段 |
| 发送 | `src/main/services/im/feishuService.ts` \`sendCardReply\` | 用渠道账号自己的客户端按 `msg_type: 'interactive'` 回复原消息 |
| 回调 | 同一个文件的 `onCardAction` | 注册到长连接 `card.action.trigger`;**只允许发起人点按钮**(卡片 value 带 `op`,回调里比对 `operator.operator_id.open_id`);命中后 `confirmToolRun(runId, allow)` 并回 toast;确认态失效时提示「已失效」 |
| 状态 | `feishuConfirm` | 由 `{runId}` 扩展为 `{runId, operatorOpenId}`;队列项 `PendingItem` 增 `senderOpenId` 透传到 `runAiTurn` |

自检:`scripts/lark-sync-selftest.mjs` 第 [15] 节 21 例 —— 卡片结构/按钮 value 契约/发起人字段/参数截断/
解析端的各种非法输入(别的卡片、缺 runId、非法动作、非对象)/回调字段提取的两种形状。

平台前提(与其它飞书能力一致,代码已就绪):应用需在开放平台开通卡片交互能力并发布版本,
长连接才能收到 `card.action.trigger`。未开通时按钮点了没反应,但**文本「确认/取消」仍然可用**。
