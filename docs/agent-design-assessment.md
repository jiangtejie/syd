# 智能体/技能/知识库设计评估与重构建议

> 状态:**方向搁置(2026-09)**。随后 AI 助手/技能/知识库功能整体下线,本文档仅作评估记录。

> 触发:参考 `D:\software\a_data\CipherTalk`(本地版,AI-SDK 版)的智能体设计,重构本仓
> 「智能体 / 技能 / 知识库」三块;本文件为**先行的全面评估与防冗余设计**,未动代码。
> 本仓对应代码:`src/main/services/ai/**`、`cap/**`、`db/repos/{agentRepo,memoryRepo,skillsRepo}`、
> 设置页/技能页。

## 1. CipherTalk 智能体设计事实(只提取与本主题相关的部分)

依据其 `electron/services/agent/**`、`services/memory/**`、`skillManagerService.ts`、`main/ipc/skillHandlers.ts`:

| 概念 | CipherTalk 的做法 |
| --- | --- |
| 运行单元 | **单一 Agent 编排引擎**(utilityProcess 子进程、基于 Vercel AI SDK + zod 工具),按 `AgentRunInput` 一次带入:provider 配置、`scope`(global / 会话 / persona)、`skills`、`mcpTools`、工具画像 `toolProfile`、输出模式。**没有“多个人设智能体表”**——人设只是 prompt 层 |
| 技能 | **技能 = Markdown 文档**(`SKILL.md` + frontmatter name/version/description + content;builtin 目录 + 用户 zip 导入/编辑/导出),**只注入指导文本、无代码执行**;运行前由宿主选择 ≤3 个、预算 ~18k 字符(`DEFAULT_SELECTED_SKILL_BUDGET`) |
| 工具装配 | 46 个工具**不每轮全塞**:常驻未分组工具 + `toolGroups.ts` 关键词命中组 + 模型 `enable_tools` 显式解锁;系统提示里的“能力菜单”是**固定文本**(跨轮不变,prompt-cache 友好),active 工具由 SDK `activeTools` 动态控制 |
| 记忆(长期) | 两层并行:① DB 记忆库(`memorySchema`:sourceType=fact/relationship/profile/…,带 entities/tags/**importance/confidence/sourceRefs 证据回引**,按 会话/联系人/群/全局 维度,夜间服务离线沉淀);② Markdown memory-bank(模型 ReAct 中自编辑 `remember/recall`,只写稳定 profile/fact,高 importance 开场注入,子任务不带)。另配 `memory_admin` 工具组(list/forget/consolidate/audit/apply_memory_fix)与审计/回滚 |
| 外围 | persona 数字分身克隆、推理画布 canvas、codeWorkspace、本地编码 agent 等——**与客服域无关,评估中明确不借鉴** |

## 2. 本仓现状盘点

| 概念 | 载体 | 注入/使用机制 | 管理 UI | 主要问题 |
| --- | --- | --- | --- | --- |
| 智能体(人设) | `ai_agent`:name/description/**style/prompt**(`schema.ts:133`) | 会话 `agentId`;`agentSystemText` 注入 prompt+风格+记忆 | 设置页“智能体”区 | **档案太薄**:无模型/温度/能力挂载/记忆范围绑定;人设与行为配置散落 |
| 常驻记忆 | `agent_memory`:content/agent_id(空=全局)/enabled(`schema.ts:206`) | 开场注入 ≤10 条/1400 字(`service.ts agentSystemText`) | 设置页记忆区(手工 CRUD) | 只有“手工条目”;无会话/客户维度、无 importance/置信/证据、无自动沉淀、无模型自编辑 |
| 知识(knowledge 类技能) | `skill_package kind=knowledge`(`schema.ts:215`) | “默认挂载”→ 全量注入 ≤1500 字(`cap/mounts defaultNames` + `assembleTurnSystem`) | 技能页 | 与“常驻记忆”职责重叠但两套表两套 UI;**全量注入无检索**,大知识无解 |
| 工具能力 | `cap/registry` L0-L3 + `chat_session.caps` 会话挂载集 | 分层目录+挂载(可自动挂载)+预算/回收;JSON 与原生双通道 | 技能页(内置软件开关)+设置页(自定义工具/MCP)+技能页(技能包) | 机制已成型;但**“默认挂载集”是代码规则**,不可按智能体配置;知识/技能/记忆三者注入分散,管理面割裂 |
| 会话级压缩 | 历史 48k/40 行 + LLM 摘要(≤400 字) | `loadHistoryCtx` | — | OK(不在重构范围) |

## 3. 冗余与重叠点(重构要消灭的)

1. **记忆/知识双轨**:`agent_memory`(手工、agent/全局)与 `skill_package knowledge`(声明式注入)语义重叠(都是“给 AI 的长期文字”),却分表、分 UI、分注入路径。
2. **注入层级各自为政**:人设(agentSystemText)+ 记忆(≤1400)+ 知识(≤1500,再挂载追加 ≤6k)在三处拼接;将来再加“模型自编辑记忆”会出现第四处。
3. **智能体档案缺“装配”字段**:能力默认挂载、知识范围、记忆范围都没与具体智能体绑定——一个“售后专家”和一个“通用助手”目前能力/记忆完全一样(能力差异只由是否绑定账号决定),档案没有业务意义。
4. **UI 分散**:智能体、记忆、自定义工具、MCP 挤在设置长页;技能与能力开关在技能页;会话挂载状态只活在 DB。管理入口不一致。
5. **两代挂载语义并存**:cap 挂载集已能表达“本会话可用什么”,而默认集、停用(config `cap.disable`)、启用技能包三处规则各自实现,易错(参考 358806d/mounts 的默认逻辑)。
6. 小冗余:技能包工具 description、cap 目录行、schema description 三份文案同源手写(可接受,暂不自动化)。

## 4. 目标模型(防冗余设计)——“一个档案,两类资产,一套装配”

### 4.1 智能体 = Agent 档案(扩展现表,不新建平行表)
`ai_agent` 扩展为完整档案(兼容旧字段,新增均可空):
- 基础:name / description / style / prompt(现状保留);
- **运行偏好**:model 覆盖(空=全局)、temperature、reasoning 提示;
- **装配**:defaultMounts(该档案新会话的默认能力挂载,空=系统默认集)、memoryScope(记忆检索范围:全局+该档案);
- 内置一个“默认助手”实例(现有 `getDefaultAgent` 语义保留)。
档案即“人设 + 能力 + 知识范围”的**唯一定义点**;会话只存档案引用 + 会话级挂载覆盖(现有 `chat_session.caps` / `agent_id`)。

### 4.2 两类长期资产,统一到一张「长期记忆库」
```
memory_item(
  id, kind: manual|fact|profile|rule|knowledge,   -- knowledge=迁移自 skill_package
  scope: agent(<id>)|global|contact|group|session, -- 客服场景:客户/群维度比会话更贴业务
  content, tags_json, importance, confidence,
  source_refs_json, created_at, updated_at)
```
- 注入:**开场 Top-N**(importance+recency,预算 ≤2000 字)——替代“agent_memory 全 10 条 + 知识全量 1500”的硬拼;
- 按需:**`remember` / `recall` 工具**(仅主会话,只读 recall + 写 remember 需确认或白名单场景),参考 CipherTalk 但**不引入其 markdown-bank 与子 agent 隔离**(我们没有子 agent,防冗余);
- 检索:FTS5/LIKE 关键词足够;**不引入 embedding/rerank**(客服词条短、量小,语义检索收益低、成本高——除非未来明确需要);
- 来源:手工(旧 agent_memory UI 改造)+ 知识技能导入 + (二期)自动沉淀(见 §6)。
- 兼容层:旧 `agent_memory`/`skill_package knowledge` 读取时迁移或按旧路径注入,避免用户数据丢失。

### 4.3 技能与能力 = 装配层(收敛现状 cap 机制)
- 保留 cap/registry + 会话挂载集(刚落地,勿推倒),只做三处收敛:
  1. 默认挂载集来源改为 **档案.defaultMounts 优先 → 系统默认**;`chat_session.caps` 仍为会话级覆盖;
  2. system 组装拆分**稳定段**(人设+记忆 TopN+能力菜单固定文本,跨轮不变)与**动态段**(会话状态+已挂载细节)——对齐 CipherTalk 固定菜单思路,对带 prompt-cache 的模型(baseUrl 前缀缓存)友好;
  3. 知识不再作为“挂载文本”拼 system,统一走记忆库 TopN/recall(§4.2)。
- 第三方技能包 tool 类、自定义工具、MCP 维持现状(已按挂载/确认工作),不并入档案字段(防冗余)。

### 4.4 管理面(一个“智能体中心”,复用现有页容量)
- 设置页智能体区升级为 **Agent 档案编辑器**(基础+运行偏好+默认挂载多选+记忆范围);
- 设置页记忆区升级为 **长期记忆库视图**(按 kind/scope 分组、importance/来源列、检索、删除/置顶);
- 技能页保留(技能包+内置能力+分层说明);MCP/自定义工具留在设置页原处;
- 会话挂载详情:AI 页头部轻量只读提示(可选二期)。

## 5. 明确不做(防冗余边界)
- persona 数字分身克隆、TTS/音色、Stickers 点播(客服场景无意义);
- 推理画布 / codeWorkspace / 本地编码 agent / 计划模式(与只读客服问答冲突);
- 独立审计/回滚表、记忆“日记”夜间任务(一期;本仓工具以只读为主,风险低);
- embedding/rerank 向量检索(见 §4.2);子 agent/委托;
- 技能执行代码(维持“无任意代码”安全模型)——CipherTalk 的 SKILL.md 无执行、本仓 http-only 白名单方向一致,不互相迁移。

## 6. 分期落地(供拍板,每期独立可交付)

- **P0(推荐,收敛核心)**:ai_agent 扩展档案字段 + 默认挂载集/记忆范围接入 engine;`memory_item` 统一表 + 旧表数据迁移/兼容;开场 Top-N 注入替换两处硬拼;`remember/recall` 工具(recall 只读,remember 需要人工确认);设置页智能体/记忆区 UI 改造;稳定段/动态段 system 拆分。
- **P1(增强,视需要)**:按客服业务自动沉淀(客户画像/群事实从 monitor 消息与 issue 提炼,参考 CipherTalk nightly 的思路但仅做 关键词抽取+重要性打分,不引大模型夜间任务除非划算);会话挂载只读提示 UI。
- **P2(不做/待需求)**:向量检索、跨设备记忆同步、审计回滚。

## 7. 验收口径(重构后)
1. 旧数据无感:既有 agent_memory、knowledge 技能、会话挂载集在升级后照常生效(或一次性迁移并提示);
2. 一个“售后专员”档案可配置:默认挂载 issue/monitor 类能力+只读工具、记忆范围限本档案,新会话即刻生效;
3. 记忆/知识注入总量从“多条并行上限”变为单预算 TopN,并支持 `recall` 按需取回客户/群事实;
4. system 文本前缀(人设+记忆+能力菜单)在会话内跨轮稳定(除记忆 TopN 变化),提示词缓存收益可观测;
5. 双通道(JSON/原生)、IM 通道、挂载守卫行为不回退(现有一组回归点:chat_service 守卫、cap/mounts、SkillsPage、设置页)。
