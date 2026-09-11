# 微信私域智能客服工作台 · 技术架构与实现要点

> 面向维护者：**为什么这么实现**、模块边界在哪、口径怎么定。产品能力与使用说明见 [README.md](README.md)。

---

## 1. 定位与技术栈

Electron 桌面应用：读本机微信数据 → 本地库与工作台 → AI 辅助（建议 / 提炼 / 复盘 / 营销内容）→ 人工闸门后发送。

| 层 | 技术 | 说明 |
| --- | --- | --- |
| 桌面框架 | Electron 39 + electron-vite 5 | 主进程 / preload / 渲染三端构建；Node 要求 `^20.19.0 \|\| >=22.12.0` |
| 渲染端 | React 19 + TypeScript 5.9 + zustand 5 | 页面、状态管理（工作台 / 会话 / toast / 确认框） |
| 图表 | ECharts 6 | 监控中心与看板的纯函数配置（`renderer/src/pages/monitorCharts.ts` 等） |
| 样式 | Tailwind 4 + 手写 CSS | 页面级 CSS 与设计 token（`assets/*.css`） |
| 本地库 | better-sqlite3-multiple-ciphers 13 | cs.db（WAL）+ 打开微信加密库（兼容 SQLCipher / 明文） |
| 模型 | AI SDK v7（OpenAI 兼容） | 任意兼容 Base URL；预设 OpenAI / DeepSeek / 百炼 / 智谱 / Moonshot / 硅基流动 / 火山方舟 / Ollama |
| 其他 | pg 8（上报）、飞书 Node SDK、fzstd（zstd）、exceljs、qrcode | — |
| 打包 | electron-builder 26 | win / mac / linux |

---

## 2. 进程架构与共享契约

```
主进程 main：窗口/托盘/菜单 + cs.db + 微信库解密读库监控 + 群问题引擎 + AI + 发送注入 + 上报 + 飞书
   ▲ ipcRenderer.invoke                      │ webContents.send（事件推送）
preload：contextBridge 暴露 window.api.cs.*（实现即契约，见下）
   ▲
渲染进程 renderer：七个页面 + zustand；只经 window.api 调 IPC，不直连任何库
```

**桥接口唯一真源**：`src/shared/api.ts` 定义 `PreloadApi`/`CsApi`，preload 以 `const api: PreloadApi = {…}` 对着它编译，
`src/preload/index.d.ts` 只剩 15 行（`window.api: PreloadApi`）。任何一边漏改都会**编译失败** ——
历史上出现过「实现加了方法、声明忘了同步」的漂移，这条约束是为此加的。

**版本错位防御**：preload 与主进程改动必须**完全重启应用**才生效（热更新只换渲染端）。
渲染端因此做了自检与降级：桥缺失时工具栏显示「⚠ 维护功能未加载」；
主进程较旧（新 IPC 无 handler）时监控页自动退回旧通道并提示「⚠ 主进程版本较旧」。

---

## 3. 目录结构

```
src/
├─ main/
│  ├─ index.ts                   入口：窗口/托盘/单实例锁/ct-media 协议/调度器起停
│  ├─ db/
│  │  ├─ database.ts             cs.db 单例（WAL、busy_timeout、mmap）
│  │  ├─ schema.ts               建表 + 增量列迁移（ensureColumn）+ 索引
│  │  └─ repos/                  数据访问：config / keyStore / issueRepo / teamRepo / chatRepo /
│  │                             imRepo / imFileRepo / imAuditRepo / growthRepo / reportRepo / sendLog …
│  ├─ ipc/                       按域注册 handler（21 命名空间 / 149 通道，见 §12）
│  └─ services/
│     ├─ wechat/                 解密/定位/读库/监控/注入/企微（见 §4）
│     ├─ feedback/               群问题闭环引擎（见 §5）
│     │  ├─ analyzer.ts          编排：读取窗口与水位、单群/全量分析、进度与取消、对外状态
│     │  ├─ shared.ts            消息/文本层公共件：消息→文本、发送人标签、证据合并、分段、读取窗口
│     │  ├─ ruleExtract.ts       规则提取（LLM 兜底：关键词聚类 + 末尾未回复）
│     │  ├─ llmExtract.ts        LLM 提取（分批消费、按段排版、行号回映射、归一化）
│     │  ├─ reconcile.ts         规则型跟进/收尾判定（归属式）
│     │  ├─ replyAttribution.ts  回复归属（纯函数，可自检）
│     │  ├─ textFilters.ts       噪音过滤：纯应答/事务性通知（纯函数，可自检）
│     │  ├─ groupScope.ts        群级监控开关（采购/供应链/内部群可排除）
│     │  ├─ duplicates.ts        存量重复议题合并
│     │  ├─ issueSimilarity.ts   议题同一性判据（纯函数，阈值真实数据标定）
│     │  ├─ scheduler.ts         后台入口（定时器 + 库变更钩子）
│     │  └─ passes/              extract / settle / escalate 三条通道 + shared
│     ├─ agent/                  数字员工值班：matcher（话术判定，纯函数）、duty（值班通道）、starters（推荐话术）
│     ├─ ai/                     provider（模型通道）、suggest（建议）、agentLoop/agentTools（迷你 Agent）、
│     │                          chat（AI 助手）、workbench（引擎/工具/审批/工作区）、cap（能力注册表/分层/软件包）
│     ├─ send/                   发送执行与闸门（队列/频控/熔断/闭环校验/审计）
│     ├─ report/                 定时任务 · 数据上报（chat_sync → PostgreSQL）
│     ├─ lark/                   飞书：client/api/im/contact/notify/tools
│     ├─ im/                     外部 IM 渠道（飞书长连接、微信 ClawBot）+ 渠道文件
│     ├─ growth/                 营销增长：collector / warehouse / buzz / remix / publisher / ai
│     ├─ media/                  图片 .dat 解密、表情、视频缓存、语音 SILK→WAV、密钥推导
│     ├─ export/                 会话/业务导出
│     ├─ logging.ts  paths.ts    统一日志、缓存分区与路径策略
│     └─ keyStoreService.ts      微信密钥（safeStorage）
├─ preload/                      contextBridge（index.ts 实现 + 15 行 index.d.ts）
├─ renderer/src/
│  ├─ App.tsx                    外壳：标题栏 + 左导航 + 页面区 + ToastHost/ConfirmHost/ErrorBoundary
│  ├─ pages/                     对话(Workbench) / AI(WorkbenchChat) / 监控 / 看板 / 客户 / 营销 / 数据 / 设置
│  ├─ components/                workbench(消息面板/群问题面板/建议面板/文件托盘) · monitor(抽屉/方案条/KPI) · settings · growth
│  ├─ stores/                    workbench / workbenchChat / toast / confirmDialog
│  └─ lib/                       customers / monitorMetrics(已迁 shared) / monitorChips / teamNames / ui / useCountUp
└─ shared/                       types.ts（领域类型）· api.ts（桥接口真源）· monitorMetrics.ts（BI 纯函数）· growth.ts
```

---

## 4. 微信数据接入

### 4.1 库解密与定位

微信 4.x 库为魔改 SQLCipher。分三层，纯计算与 IO 分离，纯的那层有自检覆盖：

- `services/wechat/crypto/sqlcipher.ts`（纯函数）：**页结构** 页 4096、reserve=80（IV 16B + HMAC-SHA512 64B）；页 1 前 16B 为 salt，加密区 `file[16:4016]`，解密后补写 `SQLite format 3\0`；页 N 加密区 `page[0:4016]`，IV 在 `page[4016:4032]`，HMAC 在 `[4032:4096)`。
- **密钥派生**：`AES key = PBKDF2-HMAC-SHA512(encKey, salt, iter=256000, dklen=32)`，逐页 AES-256-CBC（无 padding）；`verifyPage1` 先验页 1 的 HMAC，密钥不对立即失败（不再白解一整库）。
- `services/wechat/crypto/wal.ts`（纯函数）：解析 WAL 帧（32B 头 + N×(24B 帧头 + 4096B 页)）。**语义修正**：只有当「WAL 头 salt == 第一帧 salt」时才认为这是**当前日志**（可合并），此时才逐帧校验校验和、只应用到最后一个 commit 帧、按 `nTruncate` 截断；否则说明帧属于旧周期、主库已是最新，**一帧都不合并**。早期按「取头部 salt 连续段」的实现会把旧周期的页盖到新主库上，属于会读出错数据的静默错误 —— 真实数据上 20/20 个微信 WAL 都落在这个分支。
- `services/wechat/decrypt.ts`（IO）编排：`verifyWxDbKey` → 流式分页解密（`BATCH_PAGES=128`，不再整库进内存）→ **逐页 HMAC 校验**（`wechat.decrypt.verifyPages`，默认开）→ 合并 WAL → 合并后跑一次 `PRAGMA quick_check`（失败即丢弃合并结果回落主库）→ 写 `.part` 再 `rename` **原子落盘**。
- **为什么必须逐页校验**：AES-256-CBC 无 padding、页间独立，微信边写我们边读时，撕裂页会「正常解密」成垃圾数据，而副本的 mtime 比源库新 → 会被当成新鲜缓存长期使用（读出错数据的静默故障）。逐页 HMAC 是唯一能精确发现的判据（实测真实库 552/552 页匹配该布局：覆盖「加密区 + IV」+ 小端页号），失败即重解一次；仍失败则明确报「第 N 页校验失败」，**不落盘、不留坏副本**。
- **源库仍在写入时的闭环**：解密前后比对源库签名（主库 + WAL 的 size/mtime），变化就重解一次；仍变化则带 `staleSource` 标记返回（副本是某一时刻的一致快照）。源库本身已是明文库时（用户指向已解密副本）**直接只读打开源文件**，不需要密钥也不需要副本。
- **副本自愈**：明文副本打不开（半截写/坏页/新鲜度误判）→ 丢弃副本重解一次，避免「坏副本 + 判定新鲜」把某个库永久卡死。
- **明文副本**：落 `<cache>/db/<name>_<hash>.db`（以「源库路径 + key」的 md5 命名复用；历史目录 `wx-plain` 启动自动并入），只读打开、用完即关；写入前后有 `prunePlainDbCache` 按 `wechat.plainCacheMaxMB=3072` / `plainCacheMaxFiles=20` 收敛（防「解密副本把磁盘吃满」）。

缓存分区由 `paths.ts` 统一管理（**禁止硬编码子目录**）：
`db/` 明文库副本 · `media/<wxid>/` 附件解码产物（ct-media 映射根）· `files/` 渠道接收文件 · `tmp/` 一次性临时 · `export/` 导出产物 · `growth/` 营销素材。

库定位 `dbLocator.ts` 兼容 `<root>/db_storage`、`<root>/<wxid>/db_storage`、`<root>/<wxid>_xxx/db_storage`，递归扫描 `msg_*.db / message_*.db`，加权定位 `session.db / contact.db / head_image.db`。

### 4.2 密钥管理

`keyStoreService.ts`：取 key 与用 key 解耦，渲染端只看到状态。

- 来源 `registry`（注册表，待探测）/ `import`（导入）/ `manual`（手填）；导入校验 64 位十六进制。
- 落库：`safeStorage.encryptString` 加密后存 `key_store`；**明文 key 只在主进程内存**。
- 状态机 `pending → valid / invalid`：`testKey` 以「试开真实库」验证并回写错误原因。

**库密钥自动获取（可选组件，本仓不分发）**：微信 4.x 的库密钥只在微信进程内存里，社区实现靠 koffi + 自研 DLL 读内存 + Ed25519 握手，授权独立。`wechat/keyScan.ts` 只提供**接口 + 明确降级**：组件放 `<userData>/components/key-scan/index.cjs`，导出 `scan(ctx)`（ctx 给 `wxid / dbStoragePath / verify`）；组件只管找候选 key，**校验仍由我们做**（`verifyWxDbKey` 页 1 HMAC），通过才 `importKey(..., 'registry')` 落 safeStorage，随后 `testKey` 试开真实库。未装组件时返回「未安装 + 怎么手动导入」，不伪装成功。设置页按钮「自动获取密钥（可选组件）」。

**图片密钥（另一套密钥）**：图片 .dat 的 V2 用 aes-128-ecb、V3 用整文件 XOR，与库密钥无关，历史上只能手填。`media/imageKeys.ts` 现在能从本机自动推导：扫 `*_t.dat` 缩略图模板（深度 ≤8、最多 64 个）反解 XOR 低字节（自校验 `y == x ^ 0xd9` + 多模板投票），再用 V2 模板密文做一次 AES 试探（解密后必须像图片）确认 AES key。入口 `cs:wx:deriveImageKeys`，设置页「自动推导图片密钥」一键回填；推导失败仍可手填。

### 4.3 消息读取（`queries.ts` / `content.ts`）

- 会话列表读 `session.db`（兼容多表名），按 `sort_timestamp` 倒序，过滤系统号；enrich 补备注/昵称/头像/置顶/折叠。
- 消息读取：会话 id 经 md5 得表名 `msg_<hash>`，跨多个消息库合并去重，按 `(sort_seq, create_time, local_id)` keyset 分页。
- **增量读取**：`listMessagesSince` / `listMessages(..., sinceSeq)` 走 `WHERE sort_seq > ?`，SQL 侧过滤。
- **enrich 成本**：每页 enrich 都要开一次联系人库，因此大批量场景（群问题分析、上报同步）统一用 `skipEnrich` 读完整批再一次 `enrichMessages`。
- 发送人判定：Msg 表无 `is_send`，用 `real_sender_id` 对照 `Name2Id` 里「我的 rowid」。
- 内容解析：zstd 解压（magic `0xFD2FB528`）、XML/HTML 实体、按 `localType` 映射摘要（文本/图片/语音/名片/视频/表情/位置/文件/系统），提取图片 md5、语音时长、文件名大小。

### 4.4 库变更监控（`monitor.ts` + `watchService.ts`）

`fs.watch` 监听库目录 + 2s 轮询比对 mtime/size 兜底 → 500ms debounce → 广播 `cs:wx:dbChanged`（含 `sessionChanged`）并触发主进程提醒；按 wxid 管理生命周期，幂等。

---

## 5. 群问题闭环引擎（核心）

### 5.1 数据流

```
微信库 ──readGroupMessages(窗口+序号水位)──▶ 消息窗
   ├─ 主区：水位后的新行（含补录的旧时间行）──▶ LLM 分批提炼 / 规则兜底 ──▶ 议题(NewIssue)
   └─ 附录：每个 open 议题的锚点行 + 最近尾巴 ──▶ 供模型理解延续与闭环
议题 ──同一性判据(复用既有 key / 合并)──▶ upsert(cs.db: issue_feedback + _msg)
   └─ 规则跟进/收尾判定（归属式）──▶ follow_up / follow_up_at / last_reply_by / 静默收尾 / 超期搁置
```

### 5.2 提取

- **窗口与水位**：增量按水位（`msgTime` + `sortSeq` 双线单调推进），补录/回拨的旧时间消息也能读到；首次/重算按自然日窗口（默认 2 天），并向前扩展到 open 议题锚点（上限 14 天）。
- **LLM 分批**：主区按会话段（间隔 ≥15min 分段）切成 ≤200 行/批，逐批落库后再取下一批的「现存待办」提示；某批失败则从成功边界起用规则补读，杜绝高活跃群截断丢段。
- **规则兜底**：关键词命中按「同客户 + 同类型 + 60min 窗」聚成议题，另加末尾「客户留言无回复」兜底。
- **计数口径**：`count` = **真正新建**的行数（既有行更新不计），提示音/桌面通知/飞书推送据此触发。

### 5.3 跟进与收尾判定（规则管跟进、LLM 管闭环）

判定在 `reconcile.ts`，输入是消息窗 + 团队名单，输出是状态写入：

- **归属式回复判定**（`replyAttribution.ts`）：每条我方/团队消息归属给**最近一条客户消息的发送人**；议题只看「本议题客户名下、且不早于锚点」的回复。
  > 为什么不用「下一条客户消息即结束回合」：客户连发几句（补图/追问/@客服）极常见，回合会被截断，
  > 客服回复被漏掉，跟进状态永远不变（线上 issue 82 实测）。归属法同时避免了「群里另一位客户被回复」被误算。
- 锚点本身是我方/团队消息（模型把客服回复当最早证据）→ 视为已在处理中。
- **静默收尾**：本议题客户在该回复后再无发言、且静默超 `monitor.autoCloseHours`（默认 72h，0=关）→ `done(autoDone)`。
- **超期搁置**：锚点早于 14 天回溯范围且无法判定 → `stalled(auto)`。
- 跟进超时按 `follow_up_at` 动态计算（`monitor.followUpHours`，默认 12h），**不再用「最后一条证据是不是我方」这种会被重析污染的旧口径**。

### 5.4 去重（三层）

1. LLM 可指认「与既有待办 #N 是同一条」→ 直接复用其 key（`topic` 字段）；
2. 附录**优先保住每个 open 议题的锚点行**，让模型看得见原议题；证据合并（key 复用时保留最早锚点）；
3. 同一性判据兜底（`issueSimilarity.ts`，阈值用真实库标定）：标题 bigram 相似度（真重复 ≥0.40 / 不同主题 ≤0.20）、证据消息重叠覆盖率、同客户+同类型+时间邻近（弱兜底）。
   判据分**强/弱**：高置信（证据几乎完全重合、标题逐字一致、同客户同类型且证据被包含）由后台自动合并；弱信号只在监控页预览确认。合并保留最早一条（并集证据/最高严重度/并集客户/沿用跟进人），其余归档 `duplicate`。

### 5.5 后台三通道（`scheduler.ts` + `passes/`）

| 通道 | 频率 | 说明 |
| --- | --- | --- |
| `passes/extract` | 库变化事件(15s 冷却) + 60s | 近 7 天活跃群前 30 增量提取；无新消息/2 分钟内已尝试 → skipped（零 LLM）；失败不推进水位，下轮补读；**冷启动补扫**每分钟补 1 个无水位的群（不打开面板也能覆盖） |
| `passes/settle` | 2 分钟 | 对**有 open 问题的群**做规则跟进/收尾判定（零 LLM，跳过联系人 enrich）+ 高置信重复自动合并；只在真正写入时广播 |
| `passes/escalate` | 60s | 盯办升级：未指派超时（紧急 1h / 其余 4h）、已指派未处理（8h）、跟进超时 → 应用内 + 飞书，退避 45min→90min→3h→6h |

### 5.6 统计口径

- 闭环率 =（done + 已闭环后归档）÷（done + open + stalled + 已闭环后归档）；人工「不是问题」的归档不计入闭环，也不作为 LLM 反例。
- 「今日解决 / 趋势」用 `resolved_at`（置 done/stalled 时写入，重开清空），不受重析刷新 `updated_at` 影响。
- 监控总览由**主进程按全量聚合**（KPI/趋势/类型/群榜/积压年龄），只回传上限内明细（默认 1000）→ 见 `cs:issue:overview`。

---

## 6. AI 能力层

### 6.1 模型通道（`ai/provider.ts`）

统一 `complete(system, user, opts)`，配置 `ai.enabled/baseUrl/apiKey/model/temperature`（API Key 落库前 safeStorage 加封）。
未配置或调用失败时，各功能按自己的降级策略处理（建议 → 空并对 UI 报错；群问题提取 → 规则兜底；工作台 → 报错提示）。

### 6.2 回复建议（`ai/suggest.ts` + `agentLoop.ts` + `agentTools.ts`）

本地背景（本群待办、历史问题、团队名单）零成本注入 → 模型可调用**只读工具**（读群问题/搜历史/查团队）→ 输出 1~3 条候选。发送始终是人工闸门。

### 6.3 AI 工作台（`ai/workbench/*`）

标准 agent 循环：`engine`（多轮 + 工具调用 + 事件流）· `tools`（能力注册表派生的工具面）· `skills`（技能说明）· `approval`（写操作审批）· `context`/`memo`（会话上下文与备忘录）· `events`（`ai:wb` 推向渲染端）。会话可绑定**工作区目录**，智能体可读写其文件。

### 6.4 AI 助手与能力分层（`ai/chat/*` + `ai/cap/*`）

多会话助手，工具来自 `cap/registry.ts`（唯一清单：分组/停用/审批标记）与 `cap/tiers`（会话级能力分层，`chat_session.caps`）、`cap/software`（软件能力包）、`cap/mounts`、`cap/meta`（元工具，让模型自查可用能力）。

---

## 7. 发送执行与闸门（`send/*`）

- **全局串行队列**：注入是独占资源，排队逐个执行。
- **注入引擎**：`injector.ts` 调 PowerShell（`resources/ps/wechat-inject.ps1`）→ Win32 找窗口 → 抢前台 → `Ctrl+F` 搜会话 → 剪贴板粘贴 → Enter。
- **闸门与会话策略**：`sendGate.ts` 决定「AI 是否可发 / 是否需人工审批」（`send.agentEnabled`、`send.approve`）。
- **频控与熔断**：日上限（默认 200）、拟人化延迟；发送后回查微信库做**闭环校验**，连续失败自动熔断。
- **审计**：全部发送写 `send_log`（mode/source/result/verified/error_reason），看板据此出「闭环校验通过率 / 失败原因 Top」。

### 7.1 为什么这条链路要按「发出去收不回」来设计

注入的本质是「搜会话名 → 回车打开第一个结果」，**判错就是发错群**。所以加固都围绕这一点：

```
目标唯一性预检（guard.ts，纯函数）
  ├─ 同名会话            → 拒绝，提示手动发送
  ├─ 前 30 字撞车        → 拒绝（搜索词被微信截断后会指向别的会话）
  └─ 包含关系（宜家/宜家德邦）→ 拒绝（模糊搜索最易误命中）
        ↓ 通过
注入（PS：多开微信检测 → 剪贴板重试 → 焦点校验 → 粘贴 → Enter）
        ↓ 只在「粘贴正文之前」失败才安全重试一次（焦点被抢/剪贴板占用/窗口未就绪）
闭环校验（读微信库）
  ├─ 文本归一化后命中       → 已发送（verified）
  ├─ 有新发出消息但文本不同 → 视为已发送（未逐字校验），**不熔断**
  └─ 会话里没有新消息       → 失败，连续 2 次熔断（**熔断状态持久化，重启仍拦截**）
```

其他配套：队列上限 20（防雪崩）、渲染端 60s 超时兜底（防 `sending` 卡死导致全站发不出）、
渲染端以「发送时会话快照」守卫乐观回显与结果提示（防切群后消息气泡串台）。
回归：`npm run test:send`（重名/前缀/包含/归一化/比对容忍度）。

---

## 8. 外部集成

### 8.1 飞书（`lark/*` + `im/feishuService.ts`）

- **通知**：新问题 / 盯办升级 → 群或个人的文本消息（开关、事件级节流、日限额、幂等键按「事件 + 45 分钟时间片 + 问题集合」派生，跨时间片的再次提醒不会被去重吞掉），全部落 `feishu_send_log`。
- **机器人**：长连接收消息/图片/文件 → 按接收策略（`all` 私聊全收 + 群聊 @）、身份分级 → 任务化处理 → 回复（`im_audit`/`im_chat_map`/`im_file_record`）。
- **云文档工具**：Docx/Wiki/Sheets/Base/妙记/画板等经 lark-cli 工具注册表暴露给 AI（见 `docs/feishu-cloud-doc-design.md`）。

### 8.2 外部 IM 渠道（`im/*`）

飞书与微信 ClawBot 账号管理（凭证 safeStorage 加封）、渠道接收文件按 `files/` 分区归档（上限/保留期可配）、会话桥接到本地 AI 会话。

### 8.3 数据上报（`report/*`）

`chat_sync` 任务把会话/消息/媒体增量写入**你自己的 PostgreSQL**：游标增量（`report_cursor`）、媒体归档（`media_path`）、进度事件、取消、运行历史（`report_job`/`report_run`）。见 `docs/report-tasks-design.md`。

---

## 9. 营销增长模块（`growth/*`）

采集（抖音/小红书，vendor 脚本 + 解析器 + 本地导入）→ 仓库（去重/评分/标签）→ 舆情（`buzz`：门店相关评论/提及与诊断）→ 二创（`remix`：prompt + 合规检查）→ 发布/导出（`publisher/exporter`）→ AI 工作台（任务化生成/图片通道/搜索通道）。

---

## 10. 媒体与文件

- **图片**：`mediaService` + `datDecrypt` —— 定位 `msg/attach` 下 `<md5>.dat`；V1/V2（15B 头 + AES-128-ECB + XOR）、V3（整文件 XOR）；解密后处理 wxgf（HEVC 容器）：优先内嵌 JPEG/PNG，纯 HEVC 交外部 ffmpeg 转首帧；结果写 `media/<wxid>/`，经自定义 `ct-media://` 协议暴露（含路径与文件名强校验）。
- **语音**：`media/voice.ts` —— 微信 4.x 把语音 SILK 放在 `db_storage/message/media_*.db` 的 `VoiceInfo` 表（`svr_id / local_id / create_time / voice_data`）。按「消息行自己的 serverId」优先、`local_id + create_time`（按量级自动选秒/毫秒窗口）兜底定位，`silk-wasm` 解码成 PCM → 包 44 字节 WAV 头（24kHz 单声道）→ 落 `media/<wxid>/voices/<id>.wav`。渲染端只在用户点播放时才要音频（IPC `cs:media:voiceWav`），不在打开会话时批量解码。
  ct-media 协议因此多了**三段布局** `/<wxid>/voices/<id>.wav`（图片/视频仍是两段 `/<wxid>/<md5>_<kind>.<ext>`）；解析规则抽到纯函数 `media/mediaProtocol.ts` 并有自检 —— 早期把 `voices/x.wav` 整体 `encodeURIComponent`，`/` 变 `%2F` 导致整条路径只剩两段被判 403，渲染端只看到「播放失败」；现在这类 URL 由自检直接拦下。
- **语音转写（本地、离线，`media/asr.ts` + 纯逻辑 `media/asrPure.ts`）**：
  whisper.cpp 是**外部可执行文件 + 本地模型**（与 ffmpeg 同一套思路，不内置，避免安装包膨胀与授权/更新问题）。
  微信语音是 24kHz，whisper 只吃 16kHz —— 直接把 24kHz 当 16kHz 喂会变调，所以用 `media/audio.ts` 的
  「汉明窗 sinc 低通 + 线性插值」重采样（自检断言：通带 1kHz 音高不变、10.5kHz 超过目标奈奎斯特被压到 0.3%）。
  转写结果落 `voices/<serverId>.txt` **旁挂缓存**：WAV 会被容量策略淘汰，文本很小且更值钱，淘汰只清 `.wav`。
  稳健性：单进程串行（不把闲置机 CPU 打满）、超时 120s、失败只影响这一条、临时文件必清；
  配置键 `asr.whisperPath / asr.modelPath / asr.language / asr.threads / asr.timeoutMs`，没配就不转写并给出去哪配。
- **转写文本如何进入分析与数字员工**：消息读取层在 enrich 后调用 `decorateVoiceTranscripts`，
  把已缓存的转写并进 `parsedContent`（`[语音] N″ 文本`）。这样**界面、议题分析、数字员工读到的是同一份内容**，
  不需要各自去读文件；批量同步路径（`skipEnrich`）不做这次文件探测，避免拖慢上报。
- **表情/视频**：表情解析、视频缓存到 media 分区。
- **缓存容量治理**（`media/mediaCache.ts` + 纯策略 `media/mediaCachePolicy.ts`）：
  媒体目录里混着三类文件，**只有可再生的那类可以删** —— 解密产物（`<md5>_orig|thumb|hd|video|emoji.<ext>`）
  与早期遗留命名（`<md5>.<ext>`，现在已无人读取）按「年龄软上限（默认 180 天）+ 容量硬上限（默认 8GB / 5 万文件）」
  淘汰；上报归档与不认识的命名一律不动。**容量上限只算可回收部分**，否则归档一大就会把缓存全删光
  （这条语义有自检钉死）。展示缓存与归档都由 6 小时一轮的后台治理处理（`startMediaHousekeeping`），
  也挂在「文件管理 → 清理过期/孤儿」这个入口上。
- **上报归档独立成目录**：`<cache>/media/<账号>/archive/`。以前归档与展示缓存是**同一个文件**，
  一次缓存清理就会让用户 PG 里的 `media_path` 指向空气；现在归档只复制不淘汰，`media_path`
  写 `media/<账号>/archive/<文件>`（由绝对路径反推，不再拼 basename）。历史散落在 media 根的归档
  由一次性迁移复制进 `archive/`（非破坏：只复制不删除，配置门控 + 幂等）；旧 PG 行在那之后由
  **路径修复**兜底（`repairMediaPaths`：旧路径已不在、archive 下有同名文件 → 改写 `media_path`，
  游标按 `create_time` 升序单调推进，避免每轮重扫历史）。
- **渠道文件**：`im/channelFiles` 统一归档 + 限额策略 + 管理面板。

---

## 11. 本地数据模型（cs.db）

只存「索引、状态、配置、审计」，消息本体在微信库。

schema 分三层，改表前先判断属于哪一层（见 `db/schema/`）：

1. **幂等形状 DDL**（`schema/base.ts` + `schema/growth.ts`）：每次启动对齐表与索引，新装库由此建成；
2. **幂等补列**（`schema/columns.ts`）：`CREATE TABLE IF NOT EXISTS` 不会给既有表加列，缺列则 `ALTER`；
3. **一次性数据迁移**（`schema/migrations.ts`）：改形状 / 搬数据 / 清旧表，按 `PRAGMA user_version` 门控只跑一次。
   编号从 3 起（历史版本把 user_version 写成 2 却从未读过，老库停在 2，新迁移必须大于它）。
   基座 DDL 与每条数据迁移各自包事务：失败即回滚并抛给启动流程，不会留下「迁移到一半」的库。

| 表 | 状态 | 用途 |
| --- | --- | --- |
| `app_config` | 在用 | 全局 KV 配置（见 §13）。**只放配置，不放状态**：分析水位/节流戳曾以 `issue.wm:*` 之类的 JSON 串塞在这里，已迁至下面两张状态表 |
| `issue_group_state` | 在用 | 每账号每群一行：增量水位（msg_time + sort_seq）+ 自动分析节流戳 + 覆盖度 |
| `reply_script` | 在用 | 话术库（数字员工的口径）：意图 + 触发模式（关键词/正则）+ 回复模板 + 风险等级 A/B/C |
| `group_autoreply` | 在用 | 群级自动回复开关与模式（shadow/live）；未建行 = 继承全局默认 |
| `agent_reply` | 在用 | 决策与回复记录（影子与实发共用）：依据哪条话术、为什么发、发出去没有、人工反馈 |
| `agent_duty_state` | 在用 | 值班水位（每群决策到哪条消息），与议题提取水位彼此独立 |
| `issue_account_state` | 在用 | 每账号一行：最近一次全量重析结果与失败标记 |
| `key_store` | 在用 | 微信密钥（safeStorage 密文）+ 来源 + 状态 |
| `send_log` | 在用 | 发送审计（结果/闭环校验/失败原因） |
| `issue_feedback` / `issue_feedback_msg` | 在用 | 群问题议题与证据（状态/跟进/指派/复发/归档来源） |
| `team_member` | 在用 | 团队客服名单（判定「我方同事」的唯一来源） |
| `ai_agent` | 在用 | 智能体（人设/风格/提示词） |
| `chat_session` / `chat_message` / `wb_feedback` | 在用 | AI 助手/工作台会话、消息、反馈（👍/👎） |
| `im_channel_account` / `im_chat_map` / `im_audit` / `im_file_record` | 在用 | 外部 IM 渠道、会话映射、审计、接收文件索引 |
| `feishu_send_log` | 在用 | 飞书通知审计（目标/内容/结果/幂等） |
| `report_job` / `report_run` / `report_cursor` | 在用 | 定时上报任务、运行历史、增量游标 |
| `growth_*` | 在用 | 营销：门店/品牌档案、内容与素材、任务、舆情评论与提及、二创与产出 |
| `customer` / `session` / `tier_rule` / `knowledge_item` / `reply_decision` | 预留（**不再建表**） | 客户库、门控/转人工、条件规则、知识库、决策状态机。DDL 留在 `schema/reserved.ts`，接入时再搬进 `base.ts` —— 此前每次新建库都建出这 5 张空表，导致「库里有的表 ≠ 代码在用的表」 |
| `phrase_book` / `skill_package` / `agent_memory` / `ai_custom_tool` / `ai_mcp_server` | 已下线 | 老库残留，由数据迁移一次性删除（`schema/reserved.ts` 的 `LEGACY_TABLES`） |

审计类表（`im_audit` / `feishu_send_log` / `send_log`）按 `created_at` 保留 `db.retentionDays` 天（默认 90，0=不清理），
由 `db/housekeeping.ts` 启动即清一轮 + 每 6h 一次；三张表都补了 `created_at` 索引（此前零索引）。
证据表另加唯一索引 `(issue_id, seq)`，防止重复追加导致 `msgCount` 虚高。

---

## 12. IPC 一览

渲染端只经 `window.api.cs.<域>.<方法>` 调用；**21 个命名空间 / 149 个通道**，按域注册在 `src/main/ipc/*.ts`：

| 域 | 代表通道 | 说明 |
| --- | --- | --- |
| `key` | `getStatus/list/importKey/test` | 密钥状态/导入/验证 |
| `wx` | `connect/getSessions/getMessages/getMessagesSince/getAvatar/contactNames/opsStats/startWatch/deriveImageKeys/scanDbKey` | 微信读库、联系人、运营统计、监控、密钥推导/自动获取（可选组件） |
| `issue` | `list/overview/analyze/analyzeGroup/cancel/state/detail/setStatus/assign/confirmDoubt/groupBadges/mergeDuplicates/archiveStale/clear/clearGroup/listGroup` | 群问题闭环全链路 |
| `duty` | `status/scripts/scriptSave/scriptRemove/scriptToggle/scriptImport/seedStarters/groups/groupsSet/groupOne/groupSet/replies/feedback/run/preview` | 数字员工：话术库、群开关（批量）、决策记录、手动值班、回放预演 |
| `team` | `list/save/remove` | 团队客服名单 |
| `reply` | `overview/stats/getSendStatus/resetCircuit/stopAll` | 发送质量与熔断 |
| `ai` `agent` | 生成候选、智能体 CRUD | AI 建议 |
| `wb` | `listChats/searchChats/messages/create/stop/retry/approve/workspace/skills/trustTool/…` | AI 工作台 |
| `media` | `decryptImage/decryptVideo/resolveEmoji/testImageDecrypt/voiceWav` | 媒体解密（`voiceWav`：语音 SILK → WAV） |
| `files` | `policy/prune/remove/reveal` | 渠道文件管理 |
| `im` | `list/save/remove/toggle/clawQrPoll` | 外部 IM 渠道 |
| `feishu` `lark` | `notify/audit/contact/status/test` | 飞书通知与云文档 |
| `report` | `list/save/remove/setEnabled/runNow/cancel/history/testConn` | 定时上报 |
| `growth` `growthai` `growthbuzz` | 采集/仓库/二创/舆情/任务 | 营销增长 |
| `export` | `chat/business/openFolder/writeFile` | 导出 |
| `config` `app` `dialog` `logs` | 配置 KV、应用信息、目录选择、日志 | 通用 |

**推送事件**（主进程 → 渲染端）：`cs:wx:dbChanged`、`cs:issue:changed`、`cs:issue:progress`、`cs:export:progress`、`cs:report:progress`、`ai:wb`、`app:navigate`。

---

## 13. app_config 配置键

| 分组 | 键 |
| --- | --- |
| AI | `ai.enabled/baseUrl/apiKey/model/temperature/agent/nativeTools`、`wb.allowReasoner`、`wb.skills.enabled/maxOn`、`cap.disable` |
| 发送 | `send.agentEnabled`、`send.approve`、`send.dailyLimit`、`send.humanizeDelay`、`send.halted`、`inject.enabled` |
| 群问题 | `issue.autoScan.enabled`、`issue.escalate.enabled`、`issue.escalateUrgentHours`、`issue.escalateUnassignedHours`、`issue.escalateAssignedHours`、`issue.autoMergeDuplicates`、`monitor.followUpHours`、`monitor.backlogHours`、`monitor.autoCloseHours`、`monitor.alertSound` |
| 飞书 | `lark.appId`、`lark.appSecret`、`lark.defaultUrl`、`feishu.notify.enabled/targets/events/dailyLimit` |
| 上报 | `report.*`（任务本体存 `report_job`） |
| 营销 | `growth.enabled/provider/providerApiKey`、`growth.image.*`、`growth.search.*` |
| 通用 | `cache.path`、`logs.keepDays`、`logs.ringMax`、`notify.enabled`、`media.ffmpegPath`、`imFiles.autoClean/keepDays/maxBytes`、`wb.defaultWorkspace` |
| 密钥/媒体 | `img:{wxid}:xorKey`、`img:{wxid}:aesKey`、`key:{wxid}:error` |
| 解密/缓存 | `wechat.decrypt.verifyPages`（默认 true：逐页 HMAC 校验）、`wechat.decrypt.legacy`（回退旧内存整块路径）、`wechat.plainCacheMaxMB`（3072）、`wechat.plainCacheMaxFiles`（20）、`wechat.voiceCacheMaxMB`（256）、`wechat.voiceCacheMaxFiles`（500） |
| 语音转写 | `asr.whisperPath`、`asr.modelPath`、`asr.language`（默认 zh）、`asr.threads`（0=whisper 默认）、`asr.timeoutMs`（120000） |
| 媒体缓存保留 | `wechat.mediaCacheAutoClean`（默认开）、`wechat.mediaCacheKeepDays`（180）、`wechat.mediaCacheMaxMB`（8192）、`wechat.mediaCacheMaxFiles`（50000）、`wechat.report.archiveMigrated`（迁移完成标记）、`wechat.report.pathRepairCursor`（归档路径修复游标） |

---

## 14. 桌面体验

单实例锁（二次启动聚焦已有窗口）· 自定义标题栏（`titleBarStyle: hidden` + 自绘 36px 拖拽区）· 关闭最小化到托盘 · 未聚焦时桌面通知 + 任务栏闪烁（节流）· 窗口背景色与渲染端一致防白闪 · `ct-media://` 统一 dev/生产子资源加载 · 渲染端错误边界（崩了给兜底页而不是白屏）。

---

## 15. 质量与验证

```bash
npm run typecheck     # tsc --noEmit（主进程 + 渲染端）
npm run lint          # ESLint（Prettier 规则内含）
npm run test:feedback # 跟进判定「回复归属」+ 议题同一性判据 回归自检（真实数据标定）
npm run test:matcher  # 数字员工话术判定（真实群原话当夹具）
npm run test:lark     # 飞书同步字段映射（状态往返/跟进人匹配/冲突比对，纯函数）
npm run test:digest   # 日报文案（时长文案/空口径/行数上限，纯函数）
npm run test:send     # 发送前目标唯一性与文本比对（纯函数）
npm run test:schema   # schema 迁移自检：合成老库上跑三条数据迁移 + 幂等性（不碰真实库）
npm run test:crypto   # 库解密：合成 SQLCipher 页/WAL 帧，验密钥校验、篡改拒绝、页往返、WAL commit/nTruncate/断帧/跨周期
npm run test:media-proto # ct-media 路径解析：两段/三段布局、整体编码回归、目录穿越与非法命名
npm run build         # typecheck + electron-vite 三端构建
```

- **纯函数优先**：判据、归属、指标聚合都做成无 IO 的纯函数（`issueSimilarity` / `replyAttribution` / `shared/monitorMetrics`），既能两端复用，也能用真实样本做回归断言。
- **schema 三层分离**（见 §11）：幂等形状 DDL / 幂等补列 / 按 `user_version` 门控的一次性迁移，各自包事务 —— 事故教训是老库 `user_version` 早被写成 2 却不读版本号，新迁移差点被整段跳过（第一次在真实库副本上演练才发现）。
- **状态进状态表，配置进 app_config**：水位、节流戳这类会随群增长的运行态不放 KV（`app_config` 里塞状态会带来「不可查询 + 用空值当删除 + 群删了键还在」三重问题）。
- **阈值留证据**：判据阈值、窗口、上限写成模块级常量并注明标定依据；调参先看自检与线上样本。
- **事故驱动的加固**（都已沉淀为代码约束）：桥接口唯一真源（防类型漂移）、渲染端降级 + 版本提示（防主进程/渲染错位）、确认框「单回调」契约（`ConfirmDialog` 只回传一次用户选择，宿主 `onResolve` 负责 close —— 防「确认」被先到的 `onClose` 结算成「取消」，那会让所有确认类按钮点了没反应；合并重复的页内确认条是同一事故的兜底）、`skipEnrich` + 批量 enrich（防逐页开库）。

---

## 16. 数字员工（值班自动应答）

定位：这套东西**不只是监看台**，还要作为「数字员工」部署在闲置电脑上替人值班。
当前阶段 = **一期影子模式**：判定照跑、结果只记录不发送，用来校准话术与风险分级。

**通道**：`passes/reply.ts` 挂在既有调度器上，与议题引擎三条通道并列但**开关独立**
（`agent.reply.enabled`，关掉问题自动扫描不该让值班停摆）。影子期约 110s 一轮、live 期 50s 一轮，
群与群之间留 150ms 间隔；每群一轮只处理「最新一条（合并客户连发）」，冷却 90s。

**判定（纯函数）**：`agent/matcher.ts` —— 先否决（我方/同事已发言、纯应答、事务性通知、非文本、过短），
再按优先级命中话术（关键词/正则），未命中交 LLM 兜底；风险 `C` 一律转人工。
「请求 ≠ 通知」的口径落在 `feedback/textFilters.ts`：带 `发我/给我/吗/吧/多久` 等请求信号时不算事务性通知，
「收到 + 自称动作（我去安排）」算回执不算诉求。

**与议题引擎的关系**：两边各自水位、互不干扰 —— 议题引擎回答「这是不是一个要跟的问题」，
值班通道回答「这条消息要不要回、怎么回」；同事已发言时两边都退让（同一份团队名单）。

**安全边界（一期硬约束）**：不发送；非文本（图片/语音/文件）一律转人工；只承诺动作不承诺事实；
`agent_reply` 用唯一索引 `(group_username, trigger_seq)` 保证同一条消息只决策一次。

**为什么先影子**：话术覆盖与误回只能在真实消息上看出来。真实数据回放（307 条客户侧消息 + 15 条推荐话术）
得到：会按话术回 77 条（物流 35 / 缺货先发 18 / 到货 6 / 对账单 6 / 发票 4…）、转人工 5 条（退款、合同）、
非文本转人工 41 条、纯应答或通知跳过 37 条、需 LLM 兜底 147 条 —— 兜底占比偏高说明话术还没覆盖「系统下单异常」
这类真实高频场景（已补模板），也说明图片/语音理解是二期必须补的能力。

## 17. 飞书协作面（议题同步）

定位：把单机看板变成「同事也能看、也能处理」的协作面。选择飞书多维表格而不是自建 Web，
理由是可验证性优先 —— 先用最低成本验证「同事到底会不会用」，再决定要不要上控制面/数据面架构。

**模块**：`services/lark/baseSync.ts`（同步主体）+ `baseMapping.ts`（字段映射，纯函数可自检）
+ `baseSyncScheduler.ts`（每 2 分钟，先拉后推）+ `db/repos/larkSyncRepo.ts`（映射与协作列已知值）。

**为什么需要 `lark_sync_map`**：Base 没有唯一键约束，写前无法按字段去重；这张表记
`(kind, local_id) → record_id`，并额外保存 `remote_status/remote_assignee`（上次同步时 Base 上的值）。
后者是「区分同事改动 vs 自己刚写的值」的唯一依据 —— 少了它，推送与拉取会互相覆盖。

**方向与冲突**：只推不覆盖协作列；只拉「状态/跟进人」两列；冲突时本地权威（本地 updated_at 更晚则
保留本地，下一轮把本地值写回 Base）。这些判定全在 `baseMapping.ts` 里，用
`npm run test:lark` 钉死（状态往返、跟进人匹配、脱敏、冲突比对、hash 稳定性）。

**回写列**：状态 / 跟进人 / 处理备注（三列白名单）。处理备注落到 `issue_feedback.note`，
并纳入「人工字段快照」——重算会删 open 行，不纳入的话同事的结论会被无声清掉。

**影子记录推送**：`syncRepliesOut` 把 `agent_reply` 的判定/意图/拟回复/风险/人工反馈推到「数字员工回复」表，
与议题同步同样的幂等策略（映射表 + hash 跳过）；触发消息默认截断 120 字。

**每日日报**（`services/feedback/digest.ts` + `digestText.ts`）：挂在既有 60s tick 上「到点且当天未发」才发，
独立开关（`lark.digest.*`）但共用飞书通知的接收目标与日限额；文案渲染是纯函数，
`npm run test:digest` 钉死时长文案、空口径不出现、空日报兜底、行数上限（手机可读）。

**未做**：卡片交互（采纳/驳回/审批）、飞书侧改动「人工反馈」回写本地。

## 18. 待完善与已知边界

- **预留表未接入**：`customer`（客户档案，当前客户页由会话+问题派生）、`session`（门控/转人工）、`tier_rule`、`knowledge_item`、`reply_decision` —— DDL 在 `schema/reserved.ts`，**不再建表**，接入功能时搬回 `base.ts`。
- **密钥存储两种策略**：微信 DB 密钥走 `key_store` + safeStorage，图片解密密钥（`img:<wxid>:aesKey/xorKey`）仍是 `app_config` 明文，敏感度不同但应统一。
- **数字员工只到影子模式**：发送通道（live）未开；图片/语音不理解；单聊不管；话术匹配是关键词/正则，没有语义召回。
- **数字员工的前置条件**：「我方同事」名单不全时会去回同事的话 —— 上线前必须把名单标全（群问题面板的「同事标记」可批量补）。
- **growth 域无外键/级联**：父子表（素材/拆解/产出/发布结果）目前靠应用层保证，删除路径需自行清理。
- **约束偏松**：核心表 `NOT NULL` 覆盖率低（靠代码纪律保证），布尔/枚举列无 `CHECK`；`AUTOINCREMENT` 用法不统一（growth 域与审计表用，核心表不用）。
- **密钥自动探测**：`registry` 来源尚未实现，目前靠手动导入（图片密钥可从本机模板推导，见 §4.2）。
- **语音**：能解码播放（`VoiceInfo` → SILK → WAV），也能**本地转写**（whisper.cpp，见 §10）—— 但转写是**按需触发**（点气泡上的「转写」），不做批量回填；未转写的语音在分析与数字员工里仍是 `[语音] N″` 占位。
- **ct-media 不支持 Range**：协议用 `net.fetch(file://)` 直出整文件，没有 Range 响应头 —— 图片/短视频/几秒语音播放没问题，长音频拖动进度条可能不灵。
- **库密钥自动获取：接口已就绪，组件未内置**：`keyScan.ts` 的组件协议 + 页 1 校验 + 落库链路已跑通（有探针验证），但「读微信进程内存取 key」那部分依赖第三方 DLL（koffi + `wechat_key_tool.dll`），授权未确认，**不随本仓分发**：没有组件时按钮会明确提示「未安装 + 手动导入」。图片密钥不依赖任何组件，已可本地推导（§4.2）。
- **HEVC 原图**：纯 HEVC 依赖外部 ffmpeg（设置里配路径）。
- **明文副本的「新鲜度」仍是启发式**：靠 mtime + size 比较（含 `-wal`），没有把「解密时的源签名」存成 sidecar。极端情形（用保留 mtime 的方式还原/替换源库、时钟回拨）可能被误判为新鲜。已覆盖的替代判据是逐页 HMAC（解密时）与打开失败自愈（打开时）。
- **副本能打开但内部页被外部改坏**：只在「打开失败」时自愈；若副本仍能打开、只是某些页坏了，要等该页被查询才会暴露（微信库是只读副本，正常路径不会发生；逐页校验已挡住产生坏副本的主因——撕裂读）。
- **voice 缓存淘汰两处触发**：写新 WAV 之后（`pruneVoiceCache`）+ 6 小时一轮的后台治理（`pruneAllVoiceCaches`）；上限由 `wechat.voiceCacheMaxMB/Files` 控制。
- **归档目录本身没有上限**：`archive/` 是用户数据（PG 的 media_path 指着它），只报告大小、不自动清理（文件管理面板会显示「上报归档 N 个 / X MB（不清理）」）。要回收得用户自己处理。
- **旧 PG 行的兜底是「按需修复」而不是「一次性改写」**：`repairMediaPaths` 只在「旧路径文件已不在 + archive 有同名文件」时改写，单轮 300 行、游标升序推进。若某个旧文件既被回收、归档里又没有同名文件，只能报「仍缺」并留给用户重新补全（`backfillMissingMedia` 不会覆盖非空 media_path）。
- **媒体缓存的「年龄」用的是文件 mtime**：如果文件被复制/还原导致 mtime 变化，年龄判定会跟着变（只影响淘汰时机，不影响数据安全）。
- **可选组件的 require 缓存**：`keyScan` 组件是运行时 `require`，替换组件文件后需要重启应用才生效。
- **LLM 闭环依据**：自动闭环目前不落「依据行号」，不可审计（LLM 只输出状态）。
- **明细分页**：监控明细为主进程限量回传 + 归档收敛，未做服务端游标分页。
- **企微群**：后台候选群过滤掉 `isWeCom` 会话，这类群目前只在手动打开/全量重析时分析。
