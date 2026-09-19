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

**库密钥：手动导入为准（自动获取已下线）**：

当前唯一入口是设置页「微信数据与密钥」里的**手动导入**：粘贴 64 位十六进制 → `keyStoreService.importKey` 落 safeStorage →
`testKey` 试开真实库（页 1 HMAC）→ 状态机 `pending → valid / invalid`；「一键接入」（§4.3）里的密钥输入框等价于「粘贴 + 校验 + 落库」一步到位。

**一个账号只有一把密钥（口令 vs 派生密钥，2026-09-18 实测校准）**：微信 4.x 的每个库文件自带独立的随机 16 字节 salt，
该库的 AES 密钥是 `PBKDF2-HMAC-SHA512(账号口令, 该库 salt, 256000, 32)` —— **口令是同一把，派生结果按库各不相同**，
所以设置页粘一次口令就能解开该账号的全部库。微信 4.1.11+ 改变的只是「内存里缓存什么」：它缓存的是**已派生好**的每库密钥
（`Config.Cipher`），于是内存扫描会按库列出 N 个互不相同的值 —— 那些是 KDF **之后**的结果，不是 N 把独立密钥；
PBKDF2 不可逆，它们无法被合并回口令（真机实测：19 个库 19 个不同派生值，按「口令语义」0/19 通过、按「派生密钥语义」19/19 通过，且没有任何一把能开超过 1 个库）。

因此导入校验会区分两种层级：`verifyPage1`（口令语义）失败后再试一次 `verifyPage1Raw`（跳过 KDF 的派生密钥语义），
命中就明确报「这是一把库派生密钥，只能解密它对应的那一个库，不是账号口令」，而不是笼统的「密钥不正确」——
两者都是 64 位十六进制，肉眼无法区分，这也是用户最容易踩的坑。派生密钥**不被接受**为账号密钥（它开不了其余库）；
取口令本身的唯一时机是钩住微信把密钥交给 SQLCipher 的那一刻（配套工具 `wechat-decrypt-cli` 的 `scan --method hook`）。

**每库派生密钥的导入（密钥环 `db_key_map`，2026-09-18）**：既然工具默认扫出来的就是每库派生密钥，设置页支持**直接导入它的密钥文件**
（`{ version: 2, passphrase?, keys: { "session/session.db": "<64hex>" } }`，版本 1 与平铺形态也认），
口令存 `key_store`、`keys` 存 `db_key_map`（新表，按仓库约定直接写在 `schema/base.ts`，无需 user_version 迁移）。
于是拿不到口令（hook 需要管理员权限）时整套派生密钥同样能跑通 —— 这正是 4.1.11+ 的常态，不该逼用户去找那一把口令。

- 取密钥统一走 `keyStoreService.resolveKeyForFile(wxid, filePath)`：**密钥环命中就用该库的派生密钥，否则回退账号口令**。
  `WxReaderContext.keyFor(file)` / `WxSession.keyFor(file)` 是它的绑定版本，读库侧一律 `openWxDbFile(file, ctx.keyFor(file))`，
  调用方不必关心密钥来自哪一层。标签匹配（`wechat/dbKeyLabels.ts`）与配套工具的 `resolveKeyForDb` 同语义：
  精确 → 路径以 `/<label>` 结尾 → 退化文件名，所以绝对路径也能对上 `session/session.db`。
- 解密层用 `crypto/sqlcipher.ts` 的 `resolveDbFileKeys(key, page1)` 把两种层级统一成「AES key + MAC key」：
  先按口令语义（`PBKDF2(口令, 该库 salt, 256000)`）试，再按派生密钥语义（**跳过 KDF，key 即 AES key**）试。
  注意 raw 模式下 MAC key 仍要用 salt 派生（salt 异或 0x3a、迭代 2），那是 salt 唯一还被用到的地方。
- 两种层级的**入口**不同，别混：设置页单个输入框只收口令（`verifyWxDbKey`，粘派生密钥会被识别并提示改用文件导入，
  因为一把派生密钥开不了其余库）；密钥环按库取密钥走 `verifyWxDbFileKey`（两层都接受）。
- `test:crypto` 覆盖：两种层级的解析与互相拒绝、派生密钥整页解密往返、标签匹配三级语义。

> **自动获取整条链路已按用户决定下线（2026-09-11）**，相关代码与依赖全部移除：内置原生组件（`wechat_key_tool.dll` + koffi + 打包配置）、
> 外部工具命令、自备组件协议、扫本机文件、第三方工具预设（chatlog/PyWxDump/wx_key/SharpWxDump 检测与参数模板）。
> 原因是「内置 DLL 在本机取不到 key，而其余来源要么靠猜参数、要么与手动等价」，留着只是维护面。

**下线前的实测记录（供将来重启这项工作时参考，避免重复踩坑）**：
- 运行环境：微信 4.x；本机同时存在 `C:\Program Files\Tencent\Weixin\{4.1.13.7, 4.1.13.12}` 两个版本目录，
  `Weixin.exe` 资源版本 4.1.13.12，但**实际在跑的核心是 `weixin.dll` 4.1.13.7**（只有它被加载进主进程）——判版本要看已加载的 DLL；
- 组件调用链本身是通的：`wkt_challenge` 返回 32B、Ed25519 签名 64B、**认证通过**（正确签名约 120ms 且消耗该次 challenge；
  全零签名与重放都是 0ms 瞬时返回空）——但 `wkt_scan_account_auth` 与 `wkt_scan_image_key_auth` 都返回空；
- 用组件作者自己的 CLI（同一 DLL、同一机器）复现同样失败，说明不是本仓集成问题；
- 最可疑的机制（从组件二进制里读出的字符串）：它含 `weixin.dll` + `module not found`，用的是
  `CreateToolhelp32Snapshot`/`Module32FirstW` + `ReadProcessMemory`，即**必须挑到那个加载了 `weixin.dll` 的进程**；
  而本机 5 个 Weixin 进程里**只有 1 个**加载了它（pid 30064，685MB/184 模块，其余 34–159 模块都没有），
  且组件 117ms 就返回空——更像在「模块查找」阶段退出，而非扫完几百 MB 内存；
- 因此若将来重启：先让组件**遍历所有 Weixin 进程、选中 `weixin.dll` 已加载的那个**（或由宿主选好进程再把 pid 传进去），
  并注意模块真实路径在版本子目录下（`...\Weixin\4.1.13.7\Weixin.dll`），不是 exe 同级。

> 另一条历史结论仍然成立：**自己写一套「盲扫内存取 key」不可行** —— 页 1 校验对每个候选都要一次
> `PBKDF2-SHA512(256000)`（实测 70ms/次），而派生 AES key 不在内存、原始密钥虽在但无可锚定结构（详见 §18）。

**图片密钥（另一套密钥）**：图片 .dat 的 V2 用 aes-128-ecb、V3 用整文件 XOR，与库密钥无关，历史上只能手填。`media/imageKeys.ts` 现在能从本机自动推导：扫 `*_t.dat` 缩略图模板（深度 ≤8、最多 64 个）反解 XOR 低字节（自校验 `y == x ^ 0xd9` + 多模板投票），再用 V2 模板密文做一次 AES 试探（解密后必须像图片）确认 AES key。入口 `cs:wx:deriveImageKeys`，设置页「自动推导图片密钥」一键回填；推导失败仍可手填。

### 4.3 解密一体化（体检 / 一键接入 / 预热）

`services/wechat/cryptoReadiness.ts` + IPC `cs:crypto:*` + 设置页「解密一体化」卡片。

为什么单独做一层：密钥、库解密、图片密钥、语音、转写、缓存单看都能用，但运营一台闲置机器时需要的是
「现在能不能用、不能用卡在哪一步、一键跑通」，而不是在设置页里逐项试。这层只做**编排与状态汇总**：

- `discoverAccounts()`：扫 `Documents\xwechat_files\*`（含 WeChat Files 兼容位），返回 **`accountId`（目录名）+ `wxid`（去后缀）**
  两个标识 —— 本应用历史上就用目录名当账号 id 存密钥（如 `wxid_xxx_7e0b`），只用派生 wxid 查会「明明有密钥却说没有」；两者与 `dir` 一起参与匹配；
- `accountReadiness(wxid)`：7 步体检（账号目录 / 密钥 / 主要库 / 图片密钥 / 语音 / 转写 / 缓存），每步给 ok·warn·fail·skip 与原因；
- `onboardAccount({wxid?, dbPath?, keyHex?})`：定位账号 → 密钥（**粘贴并过页 1 HMAC 才落库**；不粘贴则使用已导入的密钥）→ 推导图片密钥并写配置 → 预热解密 → 回体检；成功后由 IPC 层 `wxService.connect` 拉起监控与调度器；
- `warmupAccount(wxid)`：先解主要库（session / message_0 / message_fts），让「首次打开会话、首次分析」不再承担解密开销。

真机验证（本机）：体检各项 ok（message_0.db 554 页、图片 XOR+AES 齐、media_*.db 1 个 + 已缓存 WAV 9 条、媒体缓存 490 文件/28MB、归档 27MB）；
一键接入 7/7 步成功（预热 session 219ms/36 页、message_0 228ms/554 页）；**粘贴错误密钥 → 页 1 HMAC 拒绝且不动已存密钥**；不带参数也能自动发现账号跑通。

### 4.4 消息读取（`queries.ts` / `content.ts`）

- 会话列表读 `session.db`（兼容多表名），按 `sort_timestamp` 倒序，过滤系统号；enrich 补备注/昵称/头像/置顶/折叠。
- 消息读取：会话 id 经 md5 得表名 `msg_<hash>`，跨多个消息库合并去重，按 `(sort_seq, create_time, local_id)` keyset 分页。
- **增量读取**：`listMessagesSince` / `listMessages(..., sinceSeq)` 走 `WHERE sort_seq > ?`，SQL 侧过滤。
- **enrich 成本**：每页 enrich 都要开一次联系人库，因此大批量场景（群问题分析、上报同步）统一用 `skipEnrich` 读完整批再一次 `enrichMessages`。
- 发送人判定：Msg 表无 `is_send`，用 `real_sender_id` 对照 `Name2Id` 里「我的 rowid」。
- 内容解析：zstd 解压（magic `0xFD2FB528`）、XML/HTML 实体、按 `localType` 映射摘要（文本/图片/语音/名片/视频/表情/位置/文件/系统），提取图片 md5、语音时长、文件名大小。

### 4.5 库变更监控（`monitor.ts` + `watchService.ts`）

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

**输出预算策略（`ai/outputBudget.ts`，纯函数 + 自检 `scripts/ai-budget-selftest.mjs`）**：
思考型模型（DeepSeek Reasoner、Qwen 思考模式、GLM-Z、o 系列…）的**思考过程也算进 `maxOutputTokens`**。调用点原本各自写死一个数（工作台 2400、营销 3000、JSON 路径 600），思考一长就把预算吃光、一个字正文都不写，报出来还是「模型未返回内容(预算或通道问题)」——用户既不知道原因也不知道改什么。现在收敛成一条规则：
- `planOutputBudget`：设置里的 `ai.maxOutputTokens`（>0）优先；否则用调用点默认值，**模型名看着像思考型就抬到 8192 下限**（避免必然白跑一次）；上一轮预算用完后按 **4 倍递增**，硬上限 32768。
- **两个流式引擎（`workbench/engine.ts`、`growth/ai/growthEngine.ts`）在「没有正文 + 没有跑过工具」时自动放大预算整轮重试一次**，并在事件流里明说「思考过长已耗尽输出预算，放大到 N 重试…」。跑过工具就不重试 —— 重试会重复副作用与重复审批。
- 仍然失败时给出**带真实数字**的诊断（本次输出 M tokens、其中思考 K tokens、预算上限 N）与下一步（去设置调高预算 / 换非思考模型），而不是一句「返回为空」。
- 「思考吃光预算」与「通道/结构异常」必须分开：只有**有思考或接口明说 `finish_reason=length`** 才判定为预算问题（`looksBudgetExhausted`）；后者放大预算也没用。

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
- **风控闸门（服务器侧「像不像人」，纯函数 + 自检）**：
  ① **同会话连发**：同一会话在 90 秒窗口内最多 3 条（`send.sessionBurstWindowSec` / `send.sessionBurstMax`），
  第 4 条即拦。口径刻意不做「两条之间硬间隔 N 秒」——客户追问、客服补一条，人 20 秒内回两条很正常，
  硬间隔会把正常客服一起挡住；而机器在同一会话里短时间连发很多条才是特征。
  ② **内容重复率**：同一条文案在 24 小时内发往 ≥ 20 个会话即拦（`send.dupMaxSessions` / `send.dupWindowHours`），
  比较用 `normalizeForCompare`（去空白/零宽、只比前 80 字），同文案换个称呼前缀也算同一条。
  两者都**只拒绝、不排队等待**：队列是串行的，等 90 秒会把后面所有任务一起拖住，而且渲染端 60s 就超时；
  拦截统一记 `send_log`（status=rejected）并回中文原因。设置在「设置 → 发送」里可调，0 = 关闭。
- **审计**：全部发送写 `send_log`（mode/source/result/verified/error_reason），看板据此出「闭环校验通过率 / 失败原因 Top」。

### 7.1 为什么这条链路要按「发出去收不回」来设计

注入的本质是「把消息送进指定的那个会话」，而早期实现是「搜会话名 → 回车打开第一个结果」，
**判错就是发错群且收不回**。所以这一节的加固都围绕「宁可发不出去，也不能发错」：

```
目标唯一性预检（guard.ts，纯函数）
  ├─ 同名会话            → 拒绝，提示手动发送
  ├─ 前 30 字撞车        → 拒绝（搜索词被微信截断后会指向别的会话）
  └─ 包含关系（宜家/宜家德邦）→ 拒绝（模糊搜索最易误命中）
        ↓ 通过
注入（PS：微信实例检测 → 抬窗+点开搜索框 → OCR 定位结果行并点击 → OCR 读回会话标题校验 → 清空输入框 → 粘贴正文 → Enter）
        ↓ 只在「还没输入正文」的阶段失败才安全重试一次（抢前台/剪贴板/搜索框没开/截图失败/打错会话）
闭环校验（读微信库）
  ├─ 文本归一化后命中       → 已发送（verified）
  ├─ 有新发出消息但文本不同 → 视为已发送（未逐字校验），**不熔断**
  └─ 会话里没有新消息       → 失败，连续 2 次熔断（**熔断状态持久化，重启仍拦截**）
```

其他配套：队列上限 20（防雪崩）、渲染端 60s 超时兜底（防 `sending` 卡死导致全站发不出）、
渲染端以「发送时会话快照」守卫乐观回显与结果提示（防切群后消息气泡串台）。
回归：`npm run test:send`（重名/前缀/包含/归一化/比对容忍度）、`npm run test:win`（微信窗口识别/多开判定，需 Windows）。

#### 7.1.1 微信窗口识别（`resources/ps/wechat-window.ps1`）

注入是「往当前前台窗口敲键」，**认错窗口就是发错人**，所以窗口识别按实例判定：

- **一个 PID = 一个微信客户端**（实例），同一进程下的隐藏孪生窗口、被拖出的独立聊天窗口都算同一个实例，
  不会误判成"多开"；只有**多个微信进程各有主窗口**（真·双开）才拒绝发送，并在提示里带上 pid 与窗口标题。
- 窗口来源用 `EnumWindows` 全量枚举（含类名/标题/可见/是否属于其它窗口），不再依赖
  `Get-Process` 的 `MainWindowHandle`；`WeChatAppEx`（小程序宿主）/ `WeChatOCR` 等辅助进程一律排除。
- 主窗口打分：可见 > 隐藏，标题等于「微信」> 含「微信」> 英文产品名；托盘隐藏的窗口按标题选，
  不会被同进程里那个隐藏的 `Weixin` 内部窗口抢走；恢复用 `SW_SHOW`（托盘隐藏不是最小化）。
- 校验顺序：**抢前台后先复验焦点，再敲第一个键**（搜索词也不许敲进别的应用），出现半截状态立即中止；
  剪贴板写入失败时直接返回，不再继续 `Ctrl+V` + 回车。
- 回归：`npm run test:win`、`npm run test:send`。`-Action list` 可只读打印当前识别到的实例（排查用）。

> 2026-09 事故：旧实现用 `(Get-WeChatWindows).Count` 数**窗口**，而单个窗口时 PowerShell 会把一元数组
> 塌回 Hashtable，`Hashtable.Count` 是**键数**（hwnd/title/pid = 3），于是「一个微信」被判成多开，
> **所有发送被拒**。现在判定结果一律是集合，`.Count` 对 0/1/N 都稳定。

#### 7.1.2 打开会话：微信 4.x 只能「看着点」（`resources/ps/wechat-ocr.ps1`）

「搜会话名 → 回车」在微信 4.x 上**必然打开错东西**：搜索面板最上面是「搜索网络结果」加两条联想词，
回车命中的第一行从来不是群聊。而 4.x 是自绘界面（UI Automation 只暴露一个 `MMUIRenderSubWindow`），
3.x 时代那套「UIA 读列表 + 选中行」的写法在 4.x 上直接失效。所以打开动作是：

1. **抬窗**（topmost 抖动 + `BringWindowToTop`）后**点击搜索框**——实测 `SetForegroundWindow` 对后台进程
   会被拒；即便"成功"，Qt 也收不到真正的激活（窗口看着在前台，按键全被吞掉），只有鼠标点击能激活它。
   而且**「激活窗口」的那一次点击会被系统吃掉**（生产环境里微信永远在后面，所以第一击必然被吞），
   于是搜索框要点两下：第一下激活、第二下才真正打开并聚焦。
   搜索框位置不再写死：点之前先截一帧 OCR，用**结构锚点**找它（标题栏那条带里、图标栏右侧、
   会话窗格左侧的**最靠左的短文本**就是它；会话窗格左边界由会话标题那一行给出）。拿不到就退回旧的
   固定偏移当第二意见（重试时用另一个点，避免同一点连错两次）。
2. 清空搜索框（`Ctrl+A` + `Delete` + 30 次退格：微信搜索框会记住上次的词，`Ctrl+A` 不总生效）后粘贴会话名。
3. **截图 + Windows 自带 OCR**（zh-Hans，约 150ms/帧，截图放大 2 倍）读回面板文字，按「离该行最近的区块
   表头」判定它属于哪个区：`web`（搜索网络结果＋联想词，**永不点**）、`group`（群聊）、`contact`（联系人）、
   `common`（最常使用）、`other`（功能：文件传输助手这类内置目标）、`none`（在所有**已识别**表头之上——
   微信把联系人命中放在最上面，而它那行浅灰小字表头 OCR 经常读不到）。按「是否匹配目标类型 > 中性区块 >
   表头之上 > 聊天记录」分层，再按相似度选行；长名字的行会被省略号截断，因此**比目标短且相似度≥0.5** 的行
   也算候选。**搜索框下边界是必传参数**：不加这条界，包含查询词的那一行本身就是最佳匹配，会被当成结果行点掉。
   只点**目标区块里**与目标名最像、且长度相当的那一行，然后真实点击它。
4. 再截一帧 OCR **读回会话标题**：与目标名的相似度要够高，且不能比会话列表里任何别的名字更近
   （`names` 由主进程把会话名清单写成临时文件传进来）。不达标 → **一个字都不输入**直接中止，
   提示「打开的会话不是目标会话」，杜绝发错群。
5. 通过后才清空聊天输入框（避免把别人的草稿一起发出去）→ 粘贴正文 → Enter。

**三道闸门，失败方向一律是「不发」**：① 点击前校验坐标真的落在微信窗口上（`Resolve-WxClickPoint`，
窗口被移出屏幕/太小时直接拒绝，绝不点进别的程序）；② 打开会话后 OCR 读回**会话标题**并与会话全表做最近邻
比对；③ 输入正文后 OCR 读回**聊天输入框**（长正文会滚动，判据接受任意可见片段），对不上就不按回车。
锁屏（`GetForegroundWindow()==0`）直接给明确错误，不做无谓的重试。

失败时的截图（`wx-last-search.png` / `wx-after-click.png` / `wx-last-opened.png` / `wx-before-enter.png`）留在 `userData/inject-shots/`，
可以直接看微信当时到底显示了什么。诊断：`-Action list`（微信实例）、`-Action open -Target 群名`
（只打开并读回标题，绝不输入正文）。

> 关键坑：`SwitchToThisWindow`/`SetWindowPos` 那套"硬抢前台"会让窗口**看起来**是前台但 Qt 没激活，
> 之后所有按键静默失效——所以它只在前面几招都失败时兜底使用。

---

#### 7.1.3 微信 4.x 客户端踩坑记录（实测）

这一节是「代码为什么长这样」的注解：每条都在真机上复现或量过，动这块之前先读一遍。

**客户端行为**

| 现象（实测） | 对应的代码约束 |
| --- | --- |
| UI Automation 只暴露一个 `MMUIRenderSubWindow` 自绘表面 | 3.x 时代「UIA 读列表 + 选中行」的写法失效，只能截图 + OCR |
| 搜索结果第一行永远是「搜索网络结果」+ 联想词，会话结果在下面 | 回车命中的第一行**从来不是**会话；必须按区块定位后再点击 |
| 联系人命中排在**所有区块表头之上**，而它那行浅灰小字表头 OCR 经常读不到 | 「无表头」的行必须算合法候选，否则 1:1 永远发不出去 |
| 区块不止「群聊」：还有最常使用 / 功能（文件传输助手这类内置目标）/ 聊天记录 | 表头名单要认全；漏认会让行被归到「搜索网络结果」区而被拒 |
| 表头文字 OCR 会漏字（「最常使用」读成「常使用」） | 标签按多种写法容错匹配 |
| 搜索输入框那一行 OCR **读不出内容**（只读到放大镜符号） | 判据不能依赖它（曾因此把正常搜索判成「搜索框没打开」），证据取自下拉结果行 |
| 长名字的结果行被省略号截断，且长名字 OCR 会掉字（相似度掉到 0.79） | 截断行单独放宽（比目标短 + 相似度 ≥0.5），否则长名会话发不出去 |
| 搜索框**记得上次的查询**；`Ctrl+A` + `Delete` 在微信输入框里不总生效 | 清空要退格扫尾，且要读回确认放进去的是这次的词 |
| 「激活窗口」的第一次点击**会被系统吃掉**（只把窗口带到前台，进不到控件） | 生产环境微信永远在后面 → 搜索框点两下：第一下激活、第二下打开 |
| 同一进程里有个隐藏的 `Qt51514QWindowIcon`「Weixin」窗口；托盘隐藏时主窗口 `IsWindowVisible=false` | 实例判定按 **PID**（不是窗口数）；恢复用 `SW_SHOW`（隐藏 ≠ 最小化） |
| `Get-Process.MainWindowHandle` 只给「可见且无 owner」的窗口，托盘隐藏时返回 0 | 旧实现因此「找不到微信」；窗口枚举一律走 `EnumWindows` |
| 同进程隐藏孪生窗口与主窗口标题不同（`Weixin` vs `微信`） | 主窗口按标题打分选（等于「微信」> 含「微信」> 英文名），否则会去点那个不可见的内部窗口 |

**焦点与键盘（最容易白干的一类）**

- `SetForegroundWindow` 对**后台进程会被系统拒绝**；即使「成功」，Qt 也可能收不到真正的激活 —— 窗口看着在前台，**按键被静默吞掉**。
- 反过来「硬抢前台」（`SetWindowPos` 置顶抖动 + `SwitchToThisWindow`）会让窗口**看起来**是前台而 Qt 没激活，之后所有按键继续静默失效
  → 只能当最后兜底，不能当常规手段。
- 结论：**用鼠标点击激活**（Qt 认的是这个），之后每一步都复验 `GetForegroundWindow() == 微信窗口`；不满足就一个字都不敲。

**性能（都量过，别再凭感觉优化）**

| 项 | 耗时 |
| --- | --- |
| `EnumWindows`（572 个窗口） | 2ms |
| 逐 pid `Process.GetProcessById`（112 个进程） | **550ms** ← 曾是主要开销，已改成一次快照 |
| 一次 `Process.GetProcesses()` 快照（417 个进程） | 8ms |
| `Add-Type` 编译 60 类 C# | ~100ms |
| `Add-Type -Path` 加载已编译 DLL | ~170ms ← **比现场编译还慢，所以不要做编译缓存** |

单次注入约 13s，其中约 6s 是「拟人节奏 + 等用户空闲」的有意成本，不是性能问题。

**PowerShell 5.1 / 脚本层（`resources/ps/*.ps1`）**

- **单元素数组会塌回 Hashtable**，`($r).Count` 变成**键数** —— 一个微信被判成「多开」、所有发送被拒（最初的线上故障就是这个）。
  返回值一律用集合（`New-Object ArrayList` + `return ,$list`），调用方再 `@(...)` 包一层。
- `$Pid` 是**只读自动变量**，不能当参数名（会直接报错）。
- 无 BOM 的 UTF-8 `.ps1` 会被按 **ANSI** 解析 → 这些脚本必须纯 ASCII，中文用码点拼（`[char]0x5FAE`），注释也只用英文。
- `@{ }` 里的分隔符必须是 `;` 或换行，**不能是逗号**（自检里踩过；数组字面量里逗号才是合法的）。
- `Add-Type` 的 C# 写在 here-string 里会被 `$` **插值** → C# 代码里不能出现 `$` 或反引号；
  用到的每个 `DllImport` 都要在**同一个类**里声明，少一个整段编译失败、模块直接加载不了。

**OCR（Windows 自带，zh-Hans）**

- 界面小字（约 13px）直接识别很差，**放大 2 倍**后明显变好（`Get-WxWindowShot -Scale 2`，坐标再除回去）。
- 截图取自屏幕（`CopyFromScreen`）→ 必须先抬窗且不被遮挡；锁屏 / RDP 下是黑屏，此时直接中止（安全方向）。
- OCR 的错误是**随机且局部**的（「特」读成「持」、`5` 读成 `S`）→ 判据用容错相似度 + 结构锚点，
  最后一道永远靠「读回会话标题」兜底；纯函数部分全部有真机夹具自检（`npm run test:win`）。

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

入库（粘贴抖音/小红书链接或口令解析 + 本地导入）→ 仓库（去重/评分/标签）→ 拆解（`remix`：结构 + **视觉**拆解卡）→ AI 工作台（任务化爆改 / 生图策略 / 封面合成）→ 采用 → 导出发布包（`publisher/exporter`）→ 发布登记与效果回填（`growth_metric_snapshot` → 素材分 → 看板）；另有独立的舆情通道（`buzz`：门店相关评论/提及与诊断）。

**第三方采集订阅已整体下线**（2026-09-19，按用户决定）：`collector/` 的 vendor 适配器注册表**从来没有过调用方**，`runCrawl` 必然失败、调度器只是空转心跳，界面却摆着「采集源」页让人配数据服务商。现在数据来源只有三条人工路径（粘贴链接入库 / 本地导入 / 媒体重下），`growth_subscription` / `growth_crawl_task` / `growth_remix_job` / `growth_publish_task` / `growth_publish_result` 五张无写入点的表不再新建（老库原样留着），`cs:growth:progress` 事件通道（只发过 crawl 一种 kind）与 `cs:growthai:configGet/configSet` 一并删除。

**联网搜索也已下线（2026-09-19，待重新设计）**：`growth_search_web` / `growth_search_images` 两个工具、`ai/searchProvider.ts`（bocha/tavily/serper 三家适配）与设置里的「联网搜索」卡片全部删除，营销域工具从 14 个收敛到 12 个（`scripts/tool-registry-selftest.mjs` 同步）。原因是这条链路解决的是「查门店地址/电话/口碑」这种**零散公开信息**，而运营真正要的是「这个商家/这道菜到底什么样」——下次按「商家综合信息 + 菜品信息」重新设计，先把位置空出来。当前缺事实只能追问用户或用占位符（`buildGrowthSystem` 的工作方式第 4 条已改写）。

**生图策略层（`growth/ai/imageStrategy.ts`，纯函数 + 自检 `scripts/growth-image-strategy-selftest.mjs`）**：
`imageProvider` 只是「通道」（把 prompt 发给 `/images/generations`），策略必须单独一层，否则同一家店两次生图可以毫无共同点。策略输入（平台 / 角色 / 模板 / 门店档案 / 品牌资料包 / 素材线索）→ 输出 prompt、negative、size、count 与给人看的 `notes`：

- **平台比例**：小红书与抖音给竖版 1024x1536、朋友圈与客户群给方版 1024x1024。此前只有一个全局尺寸且默认 1024x1024，竖版封面一律被生成成方图（设置里显式填了尺寸仍以填的为准，留空 = 按平台）。
- **画面模板**：内置 菜品特写/门店环境/封面氛围/人物场景 四个模板（`growth.image.templates` 可覆盖同 id 的字段或追加新模板）；不指定时按 prompt 关键词与角色自动选。
- **事实与调性**：门店招牌菜/套餐/禁用词、品牌资料包（定位/语气/主视觉色调）都拼进 prompt，禁用词进负向词。品牌资料包（`growth_brand_profile`）此前只被 UI 读写、AI 侧从未读过——现在同时进入 `buildGrowthSystem`、`growth_get_store` 与生图策略。
- **负向词**：接口不保证都支持 `negative_prompt`，统一以「【避免出现】…」拼进 prompt 文本（`composeFinalPrompt`），并固定带上「不要文字/水印/logo/可辨认人脸」。
- **张数与成本**：单次张数受设置里「每次张数」约束、硬上限 4；另有**每月张数上限**（`growth.image.monthlyLimit`，按自然月统计 `growth_asset.source_mark='gen:image'` 的行数，0 = 不限）——额度用尽时策略层在**发起请求前**就把 `blocked` 置位，调用方不得生成，并给出「到哪里调额度」的原话。张数被单次上限或月度额度压过时，都会在策略说明里如实写出（不静默少给、不静默失败）。

**配置入口在营销页**（`营销 → 设置`）：门店与品牌档案 / AI 生图同屏 —— 它们共同决定「这条内容是怎么生成的」，此前生图在 设置→AI 助手、门店品牌在营销页，排查「生成的图和门店对不上」要跨两个页面。设置页的「AI 助手」只留一行指路（可点击跳转，`stores/workbench.ts` 的 `growthTab` + `setPage`，与「监控」的 `monitorTab` 同口径）。

配置读写只有一条路径：`cs:config:getAll/set`（app_config 真源）。此前 `cs:growthai:configGet/configSet` + `GrowthAiConfigField` 白名单是同一配置的第二条写路径，渲染端从无调用者（配置面板一直走 `cs:growth`），已删除。

**封面模板引擎（`growth/cover/`）**：小红书图文的封面价值大半在「实拍图 + 大字标题」的排版上，而此前只能把裸图当封面（刚爆改出来的标题落不到图上）。实现路子是**不引任何图像库**：
- `cover/templates.ts`（纯函数 + 自检 `scripts/growth-cover-selftest.mjs`）产出一份**自包含 HTML**（底图走 `data:` URI、无外链）；
- `cover/renderer.ts` 用 **Electron 离屏窗口**（`offscreen: true` + `capturePage`）把 HTML 截成 PNG —— 排版直接用 CSS、中文字体用系统字体，`sharp`/`canvas` 那类原生依赖一律不需要跟着 Electron 重编译。
- 字号一律按**画布宽度的百分比换算成 px**，绝不用 `vw`：`vw` 跟视口走，离屏窗口尺寸一旦不是正好等于画布（边框/缩放/预览环境），整张封面的字就会放大到溢出画面（实测 480px 画布 + 1256px 视口时一行标题渲染成 1013px 高）。折行按**每个模板自己的标题框宽度**算（`titleWidthPct`），否则行会超出框宽被 CSS 二次折行。
- 封面合成是**本地渲染**，不调生图接口，因此不计入月度张数（资产 `source_mark='cover:composite'`）。

**图生图（参考图）**：`growth_gen_image` 支持 `referenceAssetId`（结构模板）+ `contentAssetId`（本店实拍），先试 `/images/edits`（multipart，多张 = **重复 `image` 字段**）生成「同构但原创」的画面；通道不支持时**回退纯文本并在回执里说明**（`isEditUnsupported` 只把 404/405/501 与"端点不支持"判为不支持，限流/参数错误照实抛出，避免用户误以为"参考图不生效"）。素材本地图的 assetId 会随 `growth_read_material` 一起给出，否则模型只能瞎猜。

- **两种模式**：给了参考图就是 `mode=edit`，prompt 三段固定 —— 【保持】（构图/机位/光线/留白，两张图时指向「图1」）、【替换为本店真实信息】、【禁止】（不带出图1 的文字/Logo/水印，不照抄摆盘人物）。生成式说"画什么"，改写式说"什么不变、什么换成我家的"，两者 prompt 结构不能混用（自检钉死）。
- **多图的分工必须写进 prompt**：图1 = 结构模板（只借构图），图2 = 本店实拍（内容以它为准）；不写清模型会把两张混着用。
- **「产物到底改没改」检测**（`ai/imageSimilarity.ts` + 自检）：图生图有一种隐蔽失败 —— 接口 200、返回的图却与参考图几乎一样（模型没接受改写，或通道把输入原样回传）。产物与结构参考图各取 16×16 灰度签名比 MAD，疑似就写进工具回执（措辞是「疑似」；阈值 4/255，两头都有自检：几乎一致要抓到、正常改写不能误报）。
- **能力探测**（`ai/imageProbe.ts`）：中转站的可用能力取决于密钥所属分组，只能实测。营销 → 设置里一键探测：默认档**不产生生图调用**（`/v1/models` + 一次故意缺参数的 `/images/edits` —— 400 = 分组开放、404 = 没开该接口），勾选后才真发 generations / edits / 多图 / mask 各一次，并如实报出计费次数。
- **视觉拆解驱动「保持」**（`remix/prompts.ts` + 自检 `scripts/growth-analyze-prompt-selftest.mjs`）：拆解卡除文字维度外还产出 `visual`（构图/机位/光线/色调/版式留白/主体占比/画面元素/图上文字），落 `growth_decomp.visual_json` —— 这一列此前**恒为 null**（拆解只写给文字看）。图生图时策略层的 `readVisualFacts` 把它变成逐项「保持」清单（`【保持】参考图的构图：居中对称；机位与视角：90 度俯拍；…`），并把参考图上的原文字点名禁带出；没有视觉拆解（旧卡/没拆过）就退回通用口径，并在 `notes` 与工具回执里如实说明（`visualLocked` 标记，不谎报"已锁定"）。拆解卡版本 `ANALYZE_VER` 升级后，建任务时会自动重拆一次（老卡不会自己变新）；素材详情里也把拆解卡（结构 + 视觉）显示出来，此前界面上只有一枚「已拆解」徽标。

**闭环的出口长在工作台里**：产出一旦「采用」，用户必须能**直接送出去** —— 产出面板头部三个动作：导出发布包（`exportPackage`，只带本任务已采用的产出 id）、登记发布（复用 `PublishRecordForm` 的内嵌弹窗，回填写 `growth_metric_snapshot`）、回素材仓库（切 `growthTab`）。此前这两个入口只在素材仓库详情里，用户得自己记住「回仓库找这条素材」，闭环在最后一跳断掉。看板的「营销内容效果」面板同理加了「去营销板块」直达：看板只读汇总，看到数字想动手就得能一步跳过去，空态文案也改成同时指路工作台与仓库。

配套的两处收敛：**候选图按张采用**（`resolveCandidate` 的 `pick` 动作，一次生图 N 张落在同一产出块里，点「用这张」只保留选中的那张，此前是整块一起采用）与**换图按 role 真替换**（`removeOutputAssetsByRole`，此前 `growth_replace_image` 只 append，换三次就攒出三张封面）。

---

## 10. 媒体与文件

- **图片**：`mediaService` + `datDecrypt` —— 定位 `msg/attach` 下 `<md5>.dat`；V1/V2（15B 头 + AES-128-ECB + XOR）、V3（整文件 XOR）；解密后处理 wxgf（HEVC 容器）：优先内嵌 JPEG/PNG，纯 HEVC 交外部 ffmpeg 转首帧；结果写 `media/<wxid>/`，经自定义 `ct-media://` 协议暴露（含路径与文件名强校验）。
- **wxgf（HEVC）多图分段（`media/datDecrypt.ts` + 自检 `scripts/wxgf-nal-selftest.mjs`）**：
  微信常在真图**之前**放一张纯白占位帧 —— 实测本机 232 张 HEVC 默认图里 42 张（18%）如此，占位帧的 IDR 只有百来字节、解出来约 6~9KB。
  早期实现切 NAL 时把起始码一起切进了 unit，`hevcNalType(unit)` 读到的永远是起始码首字节 0x00 → 类型恒为 0，
  「按 VPS 分组」的分支从未生效：整个文件被当成一段交给 ffmpeg，而 `-vframes 1` 只解第一张 = **纯白图**；
  `extractWxgfViewable` 的判据又是「第一个解出 >1KB 的就返回」，占位帧照样通过。两条合起来就是
  「配上 ffmpeg 反而比 180px 缩略图更糟」。现在 NAL 单元剔除起始码、分段真正生效，并按**载荷从大到小**尝试取第一个解得出帧的段
  （真图那段必然更大）。修完实测 232/232 全部出真图（此前纯白的那 5 张变成 790×966 / 790×996 / 602×852 / 550×954 / 600×1008）。
- **图片档位（`shared/imageTier.ts` 纯函数 + 自检）**：微信把一张图按三档落地 —— `<md5>_t.dat` 缩略图（接收即落地）、`<md5>.dat` 默认图（PC 端自动下载）、`<md5>_h.dat` 高清原图（要在客户端点开「查看原图」才有）。
  请求语义只有一条：**`best` = 高清 → 默认 → 缩略图**（`orig` 的兜底是 默认 → 高清 → 缩略图，缩略图永远排最后）。
  **三档到底差在哪**（本机实测；这里曾经按「存在率」误当成「清晰度收益」，已更正）：
  - 默认图 vs 缩略图：136 对同图配对里 **0 例缩略图更大**，默认图边长中位是缩略图的 6 倍（4KB → 76KB）——「默认图 ≥ 缩略图」成立；但体积不是判据（个别长条图默认图反而更小）。
  - 默认图 vs 高清原图：317 张里 **241 张（76%）逐字节相同**（高清档只是副本，切过去没有增益），真正更高画质的 **76 张（24%）**恰好是默认图被微信用纯 HEVC(wxgf) 压过的那批，其 `_h.dat` 为普通 JPEG/PNG，体积中位 3.5 倍、最大 61 倍。
  - 近 14 天群图 301 张：默认图 299、只有缩略图 2；同时有高清的 169 张里，134 张是副本、**35 张（占群图 11.6%）才是真升级**。
  - 比清晰度更要命的是**解得开解不开**：本机 **232/484（48%）的默认图是纯 HEVC**，而 ffmpeg 没配上时旧顺序（orig 优先）对这批**根本解不出来**（0 张能靠内嵌图直接出），只能退回 180px 缩略图；改成高清优先后其中 75 张可直接拿到真原图。
  - 配上 ffmpeg、把 HEVC 正确解码之后复核过一遍（75 张同时有高清档的图）：**高清档像素更多 10 张、基本持平 65 张、更少 0 张** —— 高清优先不会更差，这条顺序可以放心用。
  而回退成功时返回的 `ok:true` 让「拿到的是缩略图」这件事完全静默（大图预览、飞书证据附件、上报归档都以为自己拿的是原图）。
  **降级必须是可诊断的**：这条链路原来完全静默 —— 用户只看到一张糊图，日志里一个字都没有。现在
  `extractWxgfViewableDetailed` 区分 `no-ffmpeg`（可修复）与 `decode-failed`，`decryptImage` 把它归一成
  `degradedReason` 回传，主进程按「同一张图只记一次」打一条 WARN（含 md5 前 8 位与修复指引），
  渲染端在大图预览里直接写出「这张图的默认图是 HEVC，本机没有可用的 ffmpeg …… 设置 → 图片解密」。
  起因是一次真实事故：宜家德邦快运群 47 张图 **100% 是 HEVC**，而应用进程的 PATH 是 09-08 的环境快照
  （ffmpeg 后来才加进机器 PATH），spawn 报 ENOENT → 整群退回 180px 缩略图，且无处可查。
  现在 `decryptImage` 回传 `foundKind`，三处消费方各自标注：大图预览工具栏显示档位徽标（降级时给出「在微信里点开查看原图后重开即可升级」的提示）、飞书附件名带档位后缀（`image_<md5:8>_hd.jpg`）且 `lark_media_map.tier` 记住缓存那份的档位（拿到更好的档会重传，更好的才重传）、上报归档日志按档位计数（全高清不写噪音）。
- **语音**：`media/voice.ts` —— 微信 4.x 把语音 SILK 放在 `db_storage/message/media_*.db` 的 `VoiceInfo` 表（`svr_id / local_id / create_time / voice_data`）。按「消息行自己的 serverId」优先、`local_id + create_time`（按量级自动选秒/毫秒窗口）兜底定位，`silk-wasm` 解码成 PCM → 包 44 字节 WAV 头（24kHz 单声道）→ 落 `media/<wxid>/voices/<id>.wav`。渲染端只在用户点播放时才要音频（IPC `cs:media:voiceWav`），不在打开会话时批量解码。
  ct-media 协议因此多了**三段布局** `/<wxid>/voices/<id>.wav`（图片/视频仍是两段 `/<wxid>/<md5>_<kind>.<ext>`）；解析规则抽到纯函数 `media/mediaProtocol.ts` 并有自检 —— 早期把 `voices/x.wav` 整体 `encodeURIComponent`，`/` 变 `%2F` 导致整条路径只剩两段被判 403，渲染端只看到「播放失败」；现在这类 URL 由自检直接拦下。
- **语音转写（腾讯云「一句话识别」，`media/asrTencent.ts` + 纯逻辑 `asrTencentPure.ts`）**：
  选它的理由是**微信语音就是 SILK，而该接口官方支持 `VoiceFormat=silk`** —— 直接把 `VoiceInfo` 里的原始数据
  base64 直传，**不解码 WAV、不重采样**，链路最短且信息无损（限制：≤60s、base64 后 ≤3MB）。
  签名用 TC3-HMAC-SHA256，**实现与腾讯官方 Node SDK 的 `sign3` 完全一致**（SignedHeaders 取 `content-type;host`）——
  自检里存了两组**由官方 SDK 生成的黄金向量**做已知答案测试（见 `scripts/asr-tencent-selftest.mjs`）。
  凭据：`SecretId` 明文存 `app_config`，**`SecretKey` 用 `safeStorage` 加密后存 `enc:<base64>`**，
  渲染端只提交新值、只读到「已保存」；解密失败（换机器/换系统账号）按未配置处理并提示重填。
  产物：识别文本写到语音缓存目录下与 WAV 同名的 `.txt`（`media/voiceTranscript.ts` 读取，
  消息读取层 enrich 后由 `decorateVoiceTranscripts` 并进 `parsedContent`）——
  界面、议题分析、数字员工读到同一份文本；`.txt` 不参与容量淘汰（只清 `.wav`）。
  失败面：错误码/信息/RequestId 原样回给界面（`AuthFailure.*`、`RequestLimitExceeded` 等），识别为空串时报「没听清」。
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
- **大图预览几何（`renderer/src/lib/imageFit.ts` 纯函数 + 自检）**：预览的 `src` 是**会变**的（占位 → 解密真图 → 更高档位），
  而 naturalWidth/Height 是每张图各自的事实。早先把「上一张图的原图尺寸 × 缩放」写进 `style`，且尺寸一旦量到就再也不重测 ——
  本地占位 SVG（360×480）先 onLoad 定下 3:4 的盒子，随后到来的横图被强行拉成 3:4，**看起来只是图丑了**，没有任何报错。
  现在几何全部走纯函数：自然尺寸与 `src` 绑定（换图即作废、等新图 onLoad 重测），显示宽高 = 原图宽高 × 同一个缩放系数（不取整，避免小图被舍入歪比例），
  自适应可用区与 `overlays.css` 同口径（92vw / 80vh 减去弹层内边距与工具栏），窗口缩放时自适应状态会重算；解密中与加载失败各有中性提示，不再闪占位图。
  自检钉死两条不变量：**显示宽高比 == 原图宽高比**、**自适应结果放得进弹层**。
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
| `crypto` | `discover/readiness/warmup/onboard` | **解密一体化**：账号发现、体检、预热解密、一键接入 |
| `media` | `decryptImage/decryptVideo/resolveEmoji/testImageDecrypt/voiceWav/voiceTranscript/asrStatus/asrSaveSecret` | 媒体解密与云语音转写 |
| `files` | `policy/prune/remove/reveal` | 渠道文件管理 |
| `im` | `list/save/remove/toggle/clawQrPoll` | 外部 IM 渠道 |
| `feishu` `lark` | `notify/audit/contact/status/test` | 飞书通知与云文档 |
| `report` | `list/save/remove/setEnabled/runNow/cancel/history/testConn` | 定时上报 |
| `growth` `growthai` `growthbuzz` | 素材仓库/二创/舆情/任务 | 营销增长 |
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
| 营销 | `growth.image.*`（在用）；`growth.enabled/provider/providerApiKey`、`growth.search.*` 是两条已下线链路留下的键（老库可能仍有明文，仍在 `SECRET_CONFIG_KEYS` 名单里） |
| 通用 | `cache.path`、`logs.keepDays`、`logs.ringMax`、`notify.enabled`、`media.ffmpegPath`、`imFiles.autoClean/keepDays/maxBytes`、`wb.defaultWorkspace` |
| 密钥/媒体 | `img:{wxid}:xorKey`、`img:{wxid}:aesKey`、`key:{wxid}:error` |
| 解密/缓存 | `wechat.decrypt.verifyPages`（默认 true：逐页 HMAC 校验）、`wechat.plainCacheMaxMB`（3072）、`wechat.plainCacheMaxFiles`（20）、`wechat.voiceCacheMaxMB`（256）、`wechat.voiceCacheMaxFiles`（500） |
| 语音转写（腾讯云） | `asr.tencent.secretId`、`asr.tencent.secretKey`（safeStorage 密文，存 `enc:<base64>`）、`asr.tencent.region`（ap-guangzhou）、`asr.tencent.engine`（16k_zh）、`asr.tencent.voiceFormat`（silk）、`asr.tencent.timeoutMs`（20000） |
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
npm run test:media-tier  # 图片档位优先级：best/orig/thumb 的尝试顺序、后缀与中文口径、附件名带档位、归档日志文案
npm run test:image-fit   # 大图预览几何：宽高比不变量、占位图尺寸污染回归、自适应放得进弹层、脏输入兜底
npm run test:wxgf        # wxgf(HEVC) 解析：起始码剥离与多图分段（白图故障回归）、段选择、内嵌图优先、无 ffmpeg 时返回 null
npm run test:asr      # 腾讯云转写：TC3 签名对官方 SDK 黄金向量、请求体字段、响应解析
npm run test:win      # 微信窗口识别 + 搜索结果行/会话标题判定（真机 OCR 夹具，需 Windows PowerShell）
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
- **语音转写走云侧**：需要腾讯云凭据（`SecretId/SecretKey`）与开通「语音识别」服务；未配置时语音只播放不转写。
- **64 位 `svr_id` 的精度坑（已修）**：`VoiceInfo.svr_id` 是 19 位 INTEGER，经 better-sqlite3 读进 JS 会按 double 舍入
  （实测 `…795967` → `…796000`），而渲染端拿到的 `message.serverId` 正是这种值。
  语音查找因此做了三档：精确文本 → **数值容差**（`ABS(svr_id - ?) <= 4096`，相邻 svr_id 相差上亿，窗口很安全）→ `local_id + create_time`。
- **ct-media 只支持单段 Range**：`bytes=a-b` / `a-` / `-N` 都支持（206 + `Content-Range` + `Accept-Ranges`，播放器可拖进度），
  多段（multipart/byteranges）不实现 —— Chromium 媒体栈只发单段。
- **库密钥只支持手动导入/粘贴**：自动获取（内置 DLL / 外部工具 / 自备组件 / 扫本机文件 / 第三方工具预设）已按决定全部下线，原因与下线前的实测证据见 §4.2。
