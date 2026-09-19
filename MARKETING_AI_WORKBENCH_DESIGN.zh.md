# 营销 AI 工作台 · 完整设计方案（v1.0 草案）

> 目标：在营销板块内单开一个「AI 工作台」tab，把「爆款素材 → 对话式爆改 → 产出成稿」做成**任务工作区**形态（类 WorkBuddy 工作区）：左侧素材任务列表、右侧智能体对话，支持多任务并行、按元素逐项爆改，并以门店档案 + 联网搜索 + AI 生图为事实与素材来源。
> 基线：复用现有客服 AI 工作台引擎（`services/ai/workbench/engine.ts`、工具集 `tools.ts`、能力挂载 `cap/registry.ts`、审批 `approval.ts`、会话表 `chat_session/chat_message`），营销域只新增任务层、工具组与产出层。
> 状态：待评审。评审通过后按第 10 章分阶段落地。

---

## 1. 需求映射（逐条对应）

| # | 你的诉求 | 方案落点 |
|---|---|---|
| 1 | 营销的 AI 工作台单开一个 tab | 营销页新增第 2 个 tab「AI 工作台」（与 素材仓库 / 采集源 / 数据服务 并列） |
| 2 | 素材列表要有操作按钮列，可点「一键爆改」跳转 | 素材列表新增「操作」列：`一键爆改`（建任务并跳转）、`AI 拆解`、`复制文案`、`删除` |
| 3 | 左边素材任务列表 / 右边智能体对话，类似 WorkBuddy 任务 | 任务列表（进行中/已完成分组）+ 右侧对话流；一个素材 = 一个任务，可多任务并行 |
| 4 | 通过对话爆改素材的各个元素 | 营销工具组：改标题/改正文/换图/换地址/换菜名/换语气/加钩子/缩短/扩写…每个动作都是可点、可撤销的对话操作 |
| 5 | 有地方配置当前门店信息（城市、品牌等） | 新增「门店与品牌」配置（启用已建表 `growth_store` / `growth_brand_profile`）：品牌名、城市、商圈、地址、电话、营业时间、业态、人均、招牌菜、套餐、包间/停车、外卖链接、语气禁忌等 |
| 6 | 爆改过程可联网搜索图片/菜品/地址等信息去替换或 AI 生图魔改 | 搜索 provider 适配层（联网检索 + 图片检索）+ 生图 provider 适配层（即梦/万相/可灵/Seedream）；所有外部结果进入「候选素材」由对话确认后替换 |

---

## 2. 产品形态与信息架构

营销页 tab 结构（新增第 2 个）：

```
营销
├─ 素材仓库      （已有：解析入库/图集/检索/批量/灯箱…）
├─ AI 工作台 ★新增（任务式爆改工作区，本方案主体）
├─ 采集源        （已有）
└─ 数据服务      （已有）+ 新增「门店与品牌」配置入口
```

### 2.1 AI 工作台页面线框

```
┌──────────────────────────────────────────────────────────────────────────────┐
│ 营销 · AI 工作台           [+ 新建任务]  [搜索任务]      门店:[萍姐火锅·成都 ▾] │
├───────────────────┬──────────────────────────────────────────────────────────┤
│ 任务列表（左栏）    │ 任务信息条：缩略图 · 素材标题 · 目标[图文▾] · 状态 · 导出  │
│ ── 进行中 ──      ├──────────────────────────────────────────────────────────┤
│ ● 火锅点单攻略     │ 对话区（消息流 + 工具卡片）                                │
│   图文 · 3 分钟前  │   我：把标题改成带「人均 80」的版本                        │
│ ● 新品尝鲜         │   AI：已生成 3 个标题候选 → [候选卡·点选替换]              │
│ ── 已完成 ──      │   AI：正在联网查「成都 萍姐火锅 地址」→ [搜索卡·2 条结果]   │
│ ✓ 冬日暖心锅       │   AI：生成封面图 → [图片卡·4 张·点选替换]                  │
│                   │  ─────────────────────────────────────────────────────    │
│                   │  [输入框]  @素材 @门店 可粘贴图片        [发送] [停止]     │
├───────────────────┤                                                          │
│ 产出预览（可折叠）  │                                                          │
│ 标题 ×3 / 正文 ×2  │                                                          │
│ 图集 6 张 / 合规 ✓ │                                                          │
└───────────────────┴──────────────────────────────────────────────────────────┘
```

### 2.2 与素材仓库的联动

- 素材行「操作」列：`一键爆改` → 创建任务（素材 + 门店 + 目标）→ 自动切到 AI 工作台 tab 并选中该任务，**首条消息由系统预置**（拆解卡摘要 + 3 个建议动作按钮：换标题 / 换封面 / 换门店信息）；
- 任务与素材双向绑定：任务头部可点素材名回跳仓库并高亮该行；仓库行也显示「已有 N 个爆改任务」徽标；
- 若素材尚未拆解，任务创建时自动触发一次 AI 拆解（复用现有 `remix/service.analyzeContent`）。

---

## 3. 核心概念与数据模型

### 3.1 概念

| 概念 | 说明 |
|---|---|
| 任务（Task） | 一次针对某素材的爆改工作单元；一个素材可有多个任务（不同门店/不同目标/不同风格） |
| 会话（Session） | 任务的对话上下文，直接复用 `chat_session` / `chat_message`（新增 `scope` 区分营销域） |
| 产出（Output） | 任务的结果稿：标题组、正文（多版）、图集（本地/生成/替换图）、合规报告；复用 `growth_remix_output` 并扩展 |
| 门店档案（Store） | 品牌与门店事实（城市/地址/菜名/价格…），作为 AI 的"事实白名单" |
| 候选素材（Candidate） | 联网搜索/生图产出的图片，进入任务待选池，点选后替换到产出 |

### 3.2 新增/启用表

```sql
-- ① 营销 AI 任务（新增）
growth_ai_task (
  id, content_id, store_id, title,
  goal        TEXT,      -- image_text | video | moments(朋友圈) | group(群发)
  status      TEXT,      -- drafting(进行中) | ready(待发布) | done(已完成) | archived
  session_id  INTEGER,   -- 关联 chat_session.id
  stage       TEXT,      -- 当前阶段: analyze|rewrite|visual|compose|review
  summary     TEXT,      -- 一句话进度摘要(列表用)
  created_at, updated_at, last_message_at
)

-- ② 任务产出资产（新增）：图集/生成图/替换图
growth_output_asset (
  id, output_id, asset_id,   -- asset_id → growth_asset(本地已落盘)
  role        TEXT,          -- cover | image | generated | replaced
  source      TEXT,          -- store(门店实拍) | search(联网) | gen(AI生图) | material(原素材)
  prompt      TEXT,          -- 生图提示词(可追溯)
  note        TEXT,          -- 如「示意图，非实拍」
  created_at
)

-- ③ 门店档案（已建表，启用并补字段）
growth_store           -- brand_name / name / city / address / biz_type / poi_json / profile_json
growth_brand_profile   -- 品牌定位 / 人设 / 语气 / 卖点 / 禁忌词 / 视觉风格
```

> 已有表 `growth_remix_job` / `growth_remix_output` / `growth_metric_snapshot` 继续使用；任务的每次"改一版"写一条 `growth_remix_output`（variant 标记来源：`chat:title` / `chat:copy` / `chat:image`），保持历史可回溯。

### 3.3 会话隔离

复用 `chat_session`，新增一个字段区分域：`scope TEXT DEFAULT ""`（空=客服工作台；`growth`=营销 AI 工作台）。`listChats` 按 scope 过滤，两个工作台互不干扰。任务表通过 `session_id` 与对话绑定。

---

## 4. 对话驱动的爆改能力（工具集设计）

营销 AI 工作台的智能体 = 客服工作台引擎 + **营销工具组（cap group = `growth`）**。工具分两类：只读（直接执行）与写入（走现有审批机制 `approval.ts`，默认 ask）。

### 4.1 工具清单

| 工具 | 类型 | 用途 | 关键输入 | 输出 | 审批 |
|---|---|---|---|---|---|
| `growth_read_material` | 只读 | 读当前任务素材（标题/正文/图集/互动/拆解卡） | taskId | 素材结构化摘要 | 免 |
| `growth_get_store` | 只读 | 读门店/品牌档案（城市/地址/菜名/价格…） | storeId | 事实卡 | 免 |
| `growth_list_store_assets` | 只读 | 列门店自有素材（实拍图/视频） | storeId, 关键词 | 资产列表 | 免 |
| `growth_search_web` | 只读 | 联网检索（菜品做法/门店地址/口碑/行业信息） | query, 城市 | 结果卡（标题/摘要/URL/时间） | 免 |
| `growth_search_images` | 只读 | 图片检索（氛围图/菜品参考图） | query | 图片候选卡（URL/来源/版权提示） | 免 |
| `growth_gen_image` | 写入 | AI 生图（封面/氛围图/菜品示意） | prompt, 尺寸, 用途 | 生成图落盘 + 候选卡 | **需确认** |
| `growth_rewrite_title` | 写入 | 生成标题候选（3–5 条，可指定策略：人群/价格/悬念…） | 素材+门店+策略 | 候选标题组 | **需确认** |
| `growth_rewrite_copy` | 写入 | 生成/改写正文（指定风格与长度） | 素材+门店+风格 | 候选正文（A/B） | **需确认** |
| `growth_update_output` | 写入 | 把选中的候选写进任务产出（可撤销） | outputId, patch | 更新后的产出 | **需确认** |
| `growth_replace_image` | 写入 | 用候选图/门店实拍图替换产出中的某张图 | outputAssetId, newAssetId | 产出图集更新 | **需确认** |
| `growth_save_store_fact` | 写入 | 把对话中确认的门店事实写入门店档案 | 字段键值 | 档案更新 | **需确认** |
| `growth_export_package` | 写入 | 导出发布包（文案+图集+视频链接） | taskId | 导出目录 | **需确认** |
| ~~`growth_record_publish`~~ | ~~写入~~ | ~~发布登记与效果回填~~ | — | — | **已下线（2026-09-19）** |

> **状态（2026-09-19）**：上表最后一行 `growth_record_publish` 已按用户决定下线（那一步是纯手工录数字，
> 运营不会真的去填），连同 IPC、素材详情表单、`publisher/publishMetrics.ts` 与其自检一并删除，
> 营销域能力 12 → 11；`growth_metric_snapshot` 不再建表也不读写（老库历史行保留）。
> 搜索能力（`growth_search_*`）同样已下线，见 §6.1 的状态说明。

### 4.2 典型对话剧本（验收用例）

**剧本 A · 一键爆改后的第一次对话**
```
[系统预置] 已拆解《萍姐火锅点单攻略》：钩子=百香果牛肉搭配；结构=痛点→菜品→价格→促单
           建议动作：① 换标题（带人均） ② 换成成都门店信息 ③ 生成新封面
我：标题要突出「人均 80」，再给一版带「雨天」的
AI：[调用 growth_rewrite_title(策略=价格/场景)] → 返回 5 条候选 → [候选卡] 点选第 2 条写入产出
```

**剧本 B · 联网补事实**
```
我：把地址和电话补上，顺便查下我们商场停车方便吗
AI：[调用 growth_get_store] 发现档案里缺地址电话 → [调用 growth_search_web(成都 萍姐火锅 地址)]
   → [搜索卡：2 条结果] → AI 追问「确认用这条吗？确认后我写进门店档案」
我：确认
AI：[调用 growth_save_store_fact] 写入 → 后续所有文案自动带上正确地址
```

**剧本 C · 换图/生图**
```
我：封面用我们自己的百香果牛肉实拍，没有的话生成一张氛围图
AI：[调用 growth_list_store_assets] 无匹配 → 建议 ① 上传实拍 ② AI 生图
我：生成吧，暖色、火锅蒸汽、成都夜景窗边
AI：[调用 growth_gen_image] → [图片卡 4 张，均标注「AI 生成示意图」] → 点选 → 写入产出封面
```

**剧本 D · 逐元素微调（不需要大模型重写）**
```
我：正文第二段太长，删掉；把「排队」改成「翻台快」
AI：[调用 growth_rewrite_copy(指令=精简第二段)] + [调用 growth_update_output]
   → 右侧产出面板实时更新，历史版本可回退
```

---

## 5. 门店与品牌档案（AI 的事实来源）

### 5.1 配置入口

营销 → 数据服务 tab 内新增分组「门店与品牌」，或独立子页（建议独立子页 `营销 → 门店`）：

```
门店与品牌
├─ 品牌资料包（一条/品牌）
│   品牌名、定位一句话、人群、语气（亲和/专业/老板人设）、视觉风格、卖点清单、
│   禁用词、必带信息（如「每周三会员日」）
├─ 门店列表（多条）
│   门店名、城市、商圈、详细地址、电话、营业时间、业态、人均、
│   招牌菜（可多条：名称+价格+卖点+实拍图）、套餐（名称/价格/内容/适用时段）、
│   包间/停车/儿童椅/外卖平台链接、POI（抖音/小红书/大众点评）、
│   备注（如「二楼靠窗适合拍照」）
└─ 素材库入口：门店实拍图/视频（复用「上传本地素材」，标记 store_id）
```

### 5.2 AI 使用规则（防编造）

1. **事实白名单**：AI 只能使用档案里存在的门店事实；缺失字段 → 主动追问或用占位符 `【地址】`，**严禁编造**；
2. **每轮注入**：把档案压缩成「事实卡」（品牌语气 + 门店核心字段 + 招牌菜/套餐摘要）注入 system prompt；完整字段由工具按需读取，控制上下文长度；
3. **写入需确认**：AI 通过联网搜索得到的新事实（地址/电话/营业时间）必须经用户确认后由 `growth_save_store_fact` 写入；
4. **多门店**：任务绑定门店；切换门店时提示「已切换，是否按新门店重写已生成内容？」；
5. **可追溯**：产出记录生成时使用的门店档案版本（`growth_remix_output.compliance_json` 内记 `storeSnapshot` 摘要）。

---

## 6. 联网搜索与 AI 生图

> **状态（2026-09-19）**：6.1 的搜索能力**已按用户决定下线** —— `ai/searchProvider.ts`（bocha/tavily/serper）、
> `growth_search_web` / `growth_search_images` 工具、设置里的「联网搜索」卡片全部删除，营销域工具 14 → 12。
> 下面保留的是**待重新设计**的原始方案：目标是「商家综合信息 + 菜品信息」（而不是零散地查地址/电话/口碑）。
> 6.2 的生图能力已落地，见 ARCHITECTURE §9。

### 6.1 搜索能力（`services/growth/ai/searchProvider.ts`，已下线待重设计）

```ts
interface SearchProvider {
  id: string            // bocha | tavily | serper | bing
  searchWeb(q: { query: string; city?: string; count?: number }): Promise<WebResult[]>
  searchImages(q: { query: string; count?: number }): Promise<ImageResult[]>
}
interface WebResult { title: string; snippet: string; url: string; publishedAt?: number }
interface ImageResult { url: string; thumbUrl?: string; source: string; width?: number; height?: number }
```

- **接入方式**：与现有 `ai.*` 配置同构，新增 `growth.searchProvider` / `growth.searchApiKey`（Key 走 safeStorage 加密）；
- **建议供应商**：博查（国内可直连、中文效果好）、Tavily / Serper（境外、稳定）、必应 Web Search API（企业）；MVP 先接 1 家 + 可插拔；
- **缓存**：同 query 24h 本地缓存，避免重复计费；
- **合规**：只检索公开信息；搜索结果里的地址/电话/价格**必须人工确认**才写入档案；图片仅作参考，**不得直接用于对外发布**（版权），需要替换为自有实拍或 AI 生成图。

### 6.2 生图能力（`services/growth/ai/imageProvider.ts`）

```ts
interface ImageProvider {
  id: string            // jimeng | wanx | kling | seedream
  generate(q: { prompt: string; negative?: string; size: string; count: number }): Promise<GenImage[]>
}
interface GenImage { url: string; localPath?: string; width: number; height: number }
```

- **提示词模板**（内置，可编辑）：菜品特写 / 门店环境 / 封面氛围 / 人物场景，自动拼装门店风格（色调、城市元素）；
- **落盘与关联**：生成图下载到 `<cache>/growth/media`，写 `growth_asset` + `growth_output_asset(role=generated, source=gen, prompt=…)`；
- **强制标识**：所有 AI 生成图在产出中标注「AI 生成示意图」，发布包内也会带上该提示（合规）；
- **成本控制**：设置页可配月度预算与单次张数上限；超限提示而不静默失败。

### 6.3 图片替换优先级（重要）

```
门店实拍图（最高） > 用户上传图 > AI 生成图（标示意图） > 联网图片（仅参考，不可直接发布）
```

对话中 AI 会按此优先级建议；若用户执意用联网图，产出中标注来源并要求人工确认版权。

---

## 7. 技术实现方案（文件级）

### 7.1 复用清单（不重复造）

| 现有资产 | 复用方式 |
|---|---|
| `services/ai/workbench/engine.ts` | 对话主循环（流式、工具调用、审批、重试、自动标题）；新增 scope 参数与营销工具集 |
| `services/ai/cap/registry.ts` | 新增 `CapGroup = growth`，营销工具以 cap 形式注册，按会话挂载（`mounts.ts`） |
| `services/ai/workbench/approval.ts` | 写工具审批（ask/allow/deny + 会话级信任），无需改动 |
| `services/ai/provider.ts` | 原生 function-calling（`ToolSchema`）已支持，搜索/生图只是新工具实现 |
| `chat_session` / `chat_message` + `chatRepo` | 任务对话持久化；新增 `scope` 字段隔离 |
| `growth/remix/*` | 拆解、标题/正文生成、合规检查、产出落库全部复用 |
| `growth/publisher/exporter.ts` | 发布包导出复用（扩展图集来源） |
| `growth/collector/media/assetStore.ts` | 下载/落盘/协议展示复用（生图、搜索结果图统一走这里） |
| `WorkbenchChatPage.tsx` | 前端消息渲染/工具卡片/输入框交互可参考并抽取共享组件 |

### 7.2 主进程新增文件

```
src/main/services/growth/ai/
  taskService.ts       任务生命周期：createTask(contentId, storeId, goal)、listTasks、
                       bindSession、updateStage、finishTask、undoLastChange
  tools/growthTools.ts 营销工具组定义(ToolDef) + 执行器；写工具走 approval
  tools/candidates.ts  候选池：标题/正文/图片候选的暂存、点选、写回产出
  searchProvider.ts    搜索 provider 适配(bocha/tavily/serper) + 缓存 + 结果归一
  imageProvider.ts     生图 provider 适配(jimeng/wanx/kling) + 下载落盘 + 标识
  prompts.ts           门店事实卡、拆解注入、改写/生图提示词模板
src/main/db/repos/growthAiRepo.ts   growth_ai_task / growth_output_asset / 候选池 CRUD
src/main/ipc/growthAiHandlers.ts    cs:growthai:* 通道（见 7.4）
```

### 7.3 前端新增文件

```
src/renderer/src/pages/GrowthAiWorkbench.tsx      页面容器(左任务列表 + 右对话/产出)
src/renderer/src/components/growthai/
  TaskList.tsx        任务列表(分组/搜索/新建/状态点/缩略图)
  TaskHeader.tsx      任务信息条(素材缩略图/门店切换/目标/阶段/导出)
  ChatStream.tsx      消息流 + 工具卡片分发
  cards/SearchCard.tsx / ImageCard.tsx / CandidateCard.tsx / OutputDiffCard.tsx
  OutputPanel.tsx     产出预览(标题/正文/图集/合规) + 手机壳预览 + 复制/导出/回退
  Composer.tsx        输入框(@素材/@门店/粘贴图片/停止)
src/renderer/src/stores/growthAi.ts   zustand：任务列表、当前任务、消息流、产出、候选池
src/renderer/src/pages/growth-ai.css 样式(沿用 growth.css 令牌)
```

### 7.4 IPC 通道（`cs:growthai:*`）

| 通道 | 说明 |
|---|---|
| `listTasks(scope?)` / `getTask(id)` / `createTask({contentId, storeId, goal})` | 任务列表与创建（素材行「一键爆改」调用） |
| `updateTask(id, patch)` / `archiveTask(id)` / `removeTask(id)` | 任务状态管理 |
| `sendMessage(taskId, text, images?)` | 发消息（内部转 `sendWorkbenchMessage`，scope=growth） |
| `stop(taskId)` / `retry(taskId)` / `messages(taskId)` | 对话控制 |
| `resolveCandidate(taskId, candidateId, action)` | 点选候选（替换标题/正文/图片） |
| `updateOutput(taskId, patch)` / `revertOutput(taskId, versionId)` | 产出编辑与回退 |
| `listStoreAssets(storeId, kw)` / `uploadStoreAsset(storeId)` | 门店素材 |
| `saveStore(store)` / `listStores()` / `getBrandProfile()` / `saveBrandProfile()` | 门店与品牌档案 |
| `searchTest(cfg)` / `imageTest(cfg)` / `budgetStatus()` | 搜索/生图连通性与预算 |
| 事件：`ai:growthai` | 流式增量、工具开始/结束、候选就绪、产出更新（复用 WbEvent 结构） |

### 7.5 引擎接入方式（关键）

```
sendWorkbenchMessage(sessionId, wxid, text, { images, scope: "growth", tools: GROWTH_TOOL_GROUPS,
                      context: { taskId, contentId, storeId } })
  └─ 注入顺序：门店事实卡 → 素材拆解卡 → 任务目标 → 工具菜单 → 用户消息
  └─ 工具执行：growth 工具按 cap 挂载(默认挂载 core+growth；wechat 组不挂)
  └─ 写入工具：approval 拦截 → 前端审批条(或会话级信任) → 执行 → 事件回推产出更新
```

> 若直接扩展 `engine.ts` 参数影响客服工作台，可复制一份 `growthEngine.ts` 薄封装（调用同一 provider/工具/审批），仅注入不同上下文与工具集，避免回归风险。**推荐后者**。

### 7.6 任务列表的进度与状态

- `stage` 由工具执行自动推进：`analyze → rewrite → visual → compose → review`；
- `summary` 由 AI 每轮结束后写一句进度（如「已换标题与封面，待补地址」），列表直接显示；
- 任务卡片显示：素材缩略图、目标徽标、阶段进度点、最后消息时间、是否有待确认候选；
- 未读/需确认状态在任务列表右上角显示红点。

---

## 8. 关键流程时序

### 8.1 一键爆改 → 跳转

```
素材仓库行[一键爆改] → createTask(contentId, 默认门店, goal=image_text)
  → 若未拆解: analyzeContent(contentId) (复用现有)
  → 建 chat_session(scope=growth, title=素材标题) + 绑定 task.session_id
  → 预置首条系统消息(拆解摘要 + 3 个建议动作)
  → 前端 setTab("ai") + 选中任务 + 聚焦输入框
```

### 8.2 对话改文案

```
用户输入 → growthEngine.sendMessage → 模型决定调用 growth_rewrite_title
  → 审批(若开启) → 执行 → 生成候选(不直接改产出) → 事件 ai:growthai(candidate)
  → 前端候选卡展示 → 用户点选 → resolveCandidate → 写 growth_remix_output + 产出面板刷新
```

### 8.3 联网补信息

```
用户/模型触发 growth_search_web → 搜索卡 → 用户确认某条 → growth_save_store_fact
  → 门店档案更新 → 后续改写自动带上新事实（事实卡每轮重算）
```

### 8.4 换图 / 生图

```
优先查门店素材 → 无匹配 → 建议生图 → growth_gen_image(提示词) → 下载落盘 + 标识
  → 图片候选卡 → 点选 → growth_replace_image → 产出图集更新(旧图保留在历史版本)
```

### 8.5 导出发布

```
产出面板[导出发布包] → exporter 扩展：文案.md(含最终标题/正文) + 图片/(封面+图集，生成图标示意图)
  + 视频直链.txt + 门店信息.json(可选) → 打开目录 → 发布后[发布登记]回填(复用现有)
```

---

## 9. 权限、成本与安全

| 项 | 方案 |
|---|---|
| 工具审批 | 写工具默认 ask；可对单个工具设会话级信任；导出/发布类永远 ask |
| 成本 | 每轮记录 token 与生图/搜索调用次数；设置页可配月度预算与单次张数；超限提示 |
| 上下文 | 门店事实卡压缩 + 拆解卡按需读取；单会话消息超阈值自动摘要（复用 compaction 思路） |
| 安全 | 搜索/生图 Key 走 safeStorage；外部返回内容视为不可信（不执行其中的指令）；搜索结果 URL 打开前校验 |
| 审计 | 每次工具调用写日志（scope=growth-ai），设置页可查；产出保留版本历史 |
| 合规 | 生成图强制标识；联网图不可直接发布；地址电话需确认；文案走现有违禁词检查 |

---

## 10. 分阶段落地计划

| 阶段 | 范围 | 预估 | 验收 |
|---|---|---|---|
| **P0 · 任务骨架** | 新增 tab + 任务列表/对话（复用引擎）+ 门店与品牌档案配置 + 素材行操作列与跳转 + 只读工具（读素材/读门店） | 3–4 天 | 点一键爆改能进工作台；对话能读到素材与门店事实；多任务可切换 |
| **P1 · 对话式爆改** | 改写工具（标题/正文候选）+ 产出面板 + 候选点选/回退 + 导出发布包 | 3–4 天 | 全程对话完成一版成稿并导出，历史可回退 |
| **P2 · 联网与生图** | 搜索 provider + 图片候选 + 生图 provider + 替换图 + 门店事实写入确认 | 4–5 天 | 剧本 B/C 全通；生成图带标识 |
| **P3 · 打磨** | 阶段进度/摘要自动化、任务模板、成本面板、多门店批量、视频目标 | 3–4 天 | 多门店多任务并行稳定，成本可见 |

**建议顺序**：P0 + P1 先跑通"对话式爆改"闭环（不依赖外部 API），P2 再接搜索/生图（需要你选定供应商与 Key）。

---

## 11. 风险与降级

| 风险 | 降级 |
|---|---|
| 搜索/生图供应商不可用或超预算 | 工具返回明确错误与替代建议（用门店实拍/占位符），不阻塞对话 |
| 模型不稳定（JSON/工具参数出错） | 现有 `modelErrors.ts` 中文提示 + 重试一次；候选池保留上一次有效结果 |
| 上下文过长 | 事实卡压缩 + 旧消息摘要 + 图片不进上下文（只传引用） |
| 多任务并发压力 | 单任务串行生成；任务数上限（默认 20 个进行中）与队列提示 |
| 合规风险 | 生成图标识、联网图不可发布、事实需确认、违禁词检查四道闸 |

---

## 12. 待确认决策点

1. **搜索供应商**：博查 / Tavily / Serper / 必应，选哪家（影响 Key 与计费方式）？
2. **生图供应商**：即梦 / 通义万相 / 可灵 / Seedream，选哪家？是否有月预算上限？
3. **AI 是否可直接改产出**：候选必须点选（更稳，默认）还是允许 AI 自动写入后人工回退？
4. **多门店是否进 P0**：先做单门店，还是 P0 就支持多门店切换与门店级素材库？
5. **任务上限与保留策略**：进行中任务上限、已完成任务保留时长（本地数据）？
6. **视频目标**：P0 是否包含"生成视频脚本/分镜"（不生成视频文件），还是只做图文？

---

*本方案为设计稿，评审确认后按第 10 章落地；相关实现会复用现有 AI 工作台引擎与营销域既有能力，避免重复建设。*
