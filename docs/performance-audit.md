# 性能 / 渲染 / 冗余代码审计（2026-09-09）

> 范围：`src/` 全部 187 个文件（约 54,000 行，其中手写 CSS 11,132 行）+ 构建产物 + package.json。
> 方法：全量代码实读 + 静态交叉验证（引用计数 / 重复块哈希 / CSS 选择器存活检测）+ 本机微基准。
> 标记：**[已确认]** = 代码路径可完整追溯或已实测；**[需实测]** = 代码事实确认，但影响幅度取决于运行时数据量，需在真实大账号上打点。
>
> **失效项（2026-09 追加）**：本文涉及 `growth/*`（营销模块）的条目已随该模块**整体下线**失效。
> 行内保留原样以存证 —— 审计文档的价值是「当时发现了什么」，抹掉行会让人分不清是**修好了**、
> **忘了**、还是**不再适用**。不要再按这些行排期。
>
> **行号漂移（2026-11 追加）**：本文多处 `file:line` 已越界，引用的行号大于文件实际行数
> （如 `feedback/analyzer.ts:1083/772/943`，该文件现仅 753 行；`workbench.css:1968/1893`，现仅 54 行；
> `preload/index.d.ts:291/210`，现仅 13 行）。原因是后续重构缩短了文件而未回写本文。
> **结论本身仍可按模块名定位**，但不要再把这里的行号当坐标用。
>
> **已删除的「现成口子」（2026-11 追加）**：本文推荐的 `listChatMessagesTail(sessionId, limit)`
> 与渲染端 `useEscape` 当时建好后**一直零调用**，已随死代码清理删除（见 `improvement-backlog.md` A6）。
> 需要按需分页/统一 Esc 时按本文思路重写即可（各 6~20 行），不要再去找这两个函数。

---

## 0. 基线数据（本机实测，可复现）

| 测量项 | 实测值 | 说明 |
| --- | --- | --- |
| 渲染层 JS 单 chunk | **4,261 KB** | `out/renderer/assets/index-*.js`，无任何代码分割 |
| 渲染层 CSS | **661 KB** | 其中 `@layer components` **423 KB = 64%**，全部来自 HeroUI（未使用） |
| `echarts` 全量包 | **1,096 KB** | `import * as echarts from 'echarts'`，仅看板/监控用 |
| `pbkdf2Sync(256000, sha512)` | **71.6 ~ 73 ms / 次** | `openWxDbFile` **每次调用都重算** |
| 逐页 AES-256-CBC 解密 | **233 MB/s** | 100 MB 库 ≈ 0.43 s；500 MB ≈ 2.1 s |
| 本机微信库 | message_0.db 2.07 MB / contact.db 0.70 MB / session.db 0.13 MB（3 个 msg 库） | 一次 `openWxDbFile` ≈ 82 ms，**87% 是 PBKDF2** |
| typecheck / lint | `typecheck` 通过；`lint` **53 error / 157 warning** | 21 个 error 来自 `scripts/*.mjs`，其余为 `no-explicit-any`/`no-control-regex`/react-hooks |

---

## 1. P0 — 必修（性能/正确性，按收益排序）

### P0-1 微信库每次打开都全量重解密（主进程冻结的根因）**[已确认]**

`src/main/services/wechat/decrypt.ts:148`

```ts
export function openWxDbFile(filePath, hexKey) {
  const tmpPath = getPlainDbPath(filePath, hexKey)
  const decrypted = decryptWxDbFile(filePath, hexKey, tmpPath)  // 每次都重读+重解密+重写整个库
  ...
}
```

`decrypt.ts:46/56/60/140` 每次都执行：`readFileSync` 全库 → `pbkdf2Sync`（71.6 ms）→ 逐页 `createDecipheriv` → `writeFileSync` 全库明文。
`decrypt.ts:169` 的注释写着「重复打开会覆盖刷新」，但**代码没有任何新鲜度判断**；`ARCHITECTURE.md` 里「解密结果落盘…复用」的描述与实现不符。

**改法**（约 15 行，收益最大）：

```ts
const aesKeyCache = new Map<string, Buffer>()   // key = hexKey + '|' + salt.toString('hex')

export function openWxDbFile(filePath: string, hexKey: string) {
  const tmpPath = getPlainDbPath(filePath, hexKey)
  const srcMtime = Math.max(mtimeMs(filePath), mtimeMs(filePath + '-wal'))
  if (mtimeMs(tmpPath) >= srcMtime && sizeOf(tmpPath) > 0) {
    return { db: new Database(tmpPath, { readonly: true }) }   // 命中：不解密
  }
  const decrypted = decryptWxDbFile(filePath, hexKey, tmpPath)
  ...
}
```

预期：单次开库 82 ms → ~2 ms；大库（500 MB）从数秒 → 毫秒级。**需实测**真实账号耗时。

---

### P0-2 一次 `getSessions` = 4 次全解密 + 4 次递归目录遍历，且被 3 个页面各自订阅 **[已确认]**

`src/main/services/wechat/wxService.ts:57`

```ts
result = listSessions(session)                        // openWxDbFile(session.db)
const sessions = enrichSessionsWithContacts(...)      // openWxDbFile(contact.db)
annotateUnreadLastSender(sessions, session)           // 打开**每一个** msg 库（只为取各表最新一行）
```

`queries.ts:421` 循环 `openWxDbFile` 每个消息库；`dbLocator.locateWeChatDbs` 被调用 4 次（`queries.ts:235/276/407` + `findContactDb` 内部），每次递归 `readdirSync`+`statSync`。

渲染端 4 处订阅 `onDbChanged`（无合并）：`SessionList.tsx:196`、`CustomersPage.tsx:166`、`DashboardPage.tsx:404` 各自 `refreshSessions()`；`Workbench.tsx:27` → `refreshCurrentMessages()`。
主进程 `monitor.ts:80` 每 2 s 轮询 + 500 ms 防抖 → 活跃期约每 2.5 s 触发一次。本机单次 `getSessions` ≈ 330 ms **同步阻塞**；大账号数秒。

**改法**：
1. `getSessions` 加结果缓存（key=wxid，TTL 2~5 s，dbChanged 精确失效）——`opsStats.ts:50-65` 已是现成模板。
2. `locateWeChatDbs` / `findContactDb` / `findDbFileByName` 加进程级路径缓存（TTL 30 s）。
3. `refreshSessions` 加 in-flight 合并（同一时刻只发一次 IPC）；渲染端 `onDbChanged` 统一节流 1~2 s。
4. `annotateUnreadLastSender` 先按 mtime 选最新 1 个 msg 库，不要为取 1 行解密所有库。

---

### P0-3 分页读消息 = 页数 × 库数 次全解密 **[已确认]**

`src/main/services/wechat/queries.ts:755` 每个消息库、**每一页**都 `openWxDbFile`，而 SQL 只取 `LIMIT 51`。

调用方循环翻页：

| 位置 | 规模 |
| --- | --- |
| `feedback/analyzer.ts:246` `readGroupMessages` | 80 条/页，最多 10 页（`MAX_GROUP_MSGS=800`） |
| `feedback/analyzer.ts:1083` `analyzeIssues` | 最多 30 个群依次执行 |
| `report/chatSyncRunner.ts:358` | 每会话多页 |
| `export/exportService.ts:79` | 每会话多页 |
| `stores/workbench.ts:463` `locateIssueAt` | 最多 15 页 |
| `Workbench.tsx:27` `refreshCurrentMessages` | 每次 dbChanged（~2.5 s） |

本机最坏：10 页 × 3 库 × 82 ms ≈ **25 s**（一次打开群问题）；30 个群则数量级更大。这是「打开群问题就卡死」的根因。

**改法**：先做 P0-1（第二页起命中缓存，82 ms → ~2 ms）；再把 `openWxDbFile` 结果在单次 `listMessages` 调用内跨页复用；`analyzer.ts:772 peekLatestRow` 改成只读 1 行的轻量查询。

---

### P0-4 流式输出每帧重渲染整个 AI 工作台，且 store 就地改数组（改 selector 会直接坏） **[已确认]**

`src/renderer/src/stores/workbenchChat.ts:159`

```ts
function appendTurnToken(kind, token) {
  const blocks = useWorkbenchChatStore.getState().turnBlocks
  blocks[blocks.length - 1] = { ...last, text: (last.text ?? '') + token }  // 就地改
  useWorkbenchChatStore.setState({ turnBlocks: blocks })                    // 同一个数组引用
}
```

`src/renderer/src/pages/WorkbenchChatPage.tsx:556`

```tsx
const store = useWorkbenchChatStore()                          // 无 selector：订阅整个 state
const turnBlocks = useWorkbenchChatStore((s) => s.turnBlocks)   // 引用不变 → 这个 selector 永不触发
```

zustand v5 用 `Object.is` 比较 selector 返回值：`s => s.turnBlocks` **不会**因就地修改而重渲染。当前流式文字能刷新，**完全依赖 :556 的全量订阅**。后果：
1. 任何「把 :556 改成细粒度 selector」的正常优化会**直接让流式正文不再刷新**；
2. 就地修改 store 数组违反不可变约定，并发渲染下可能丢帧。

同类：`GrowthAiWorkbench.tsx:265/343/585`（`streaming` 每帧 `setState` + `TaskCard` 未 memo + `onDelete={(x) => void removeTask(x)}` 内联箭头击穿 memo）；`GrowthPage.tsx:1135`（输入框 state 与 100 行表格同层）；`BuzzPanel.tsx:96`（搜索草稿与 200 行列表同层）。

**改法（顺序不能反）**：
1. 先把 `appendTurnToken` 改为返回新数组（`setState((st) => ({ turnBlocks: [...] }))`）；`workbenchChat.ts:633-659` 的 tool 块同理。
2. 再把 `WorkbenchChatPage.tsx:556` 拆成 7 个细粒度 selector。
3. `TaskCard` 加 `memo` + `useCallback` 稳定 `onDelete`；流式气泡抽成独立 memo 叶子组件。
4. 长列表与输入草稿分层（`IngestBar`/`KeywordBox`/`Composer` 各自持有草稿 state）。

---

### P0-5 `stopSending()` 丢弃队列不 resolve → 渲染端 `await` 永久挂起 **[已确认]**

`src/main/services/send/sendService.ts:292`

```ts
export function stopSending(): void {
  halted = true
  queue.splice(0)      // 队列里每个 job 的 resolve 永远不被调用
}
```

`enqueueSend`（:259）返回的 Promise 只有 `job.resolve()`（:131/142/152/253）才会 settle。`src/main/ipc/sendHandlers.ts:100` 的 `cs:reply:stopAll` 直接调用它。

**改法**：

```ts
export function stopSending(): void {
  halted = true
  for (const job of queue.splice(0)) {
    job.resolve({ ok: false, status: 'halted', error: '已停止发送队列', verified: false, at: Date.now() })
  }
}
```

> 注：`cs:reply:stopAll` 目前无 preload 封装（见 P1-8），所以触发面主要是退出流程；修掉它同时让该通道可安全启用。

---

### P0-6 问题看板 `listIssues`：N+1 + 缺索引 + 每行读配置 **[已确认]**

`src/main/db/repos/issueRepo.ts:393` 每行一次 `SELECT COUNT(*)`；`issueRepo.ts:131 decorateFollowUpOverdue` 每行又一次 SQL + 一次 `getConfigNumber`（再一条 SQL）；`schema.ts:104/119` 的 `issue_feedback` / `issue_feedback_msg` **没有任何索引**（`issue_id` 无索引 → 每行 COUNT 与 `ORDER BY seq DESC LIMIT 1` 都全表扫）。同款 N+1 还在 `openIssuesForGroup:353`、`listIssuesByGroup:413`、`searchIssues:480`。

**改法**：
```sql
CREATE INDEX IF NOT EXISTS idx_issue_fb_scope ON issue_feedback(wxid, status, occur_at DESC);
CREATE INDEX IF NOT EXISTS idx_issue_fb_group ON issue_feedback(wxid, group_username, status);
CREATE INDEX IF NOT EXISTS idx_issue_fb_msg_issue ON issue_feedback_msg(issue_id, seq DESC);
```
并把 msgCount 改成一次 `GROUP BY` 聚合、`followUpHours` 提到 map 外读一次；列表加 `LIMIT`（如 2000）+ 渲染端关键词 200 ms 防抖。

---

### P0-7 首屏单 chunk 4.26 MB + echarts 全量 + 零代码分割 **[已确认]**

- `src/renderer/src/components/EChart.tsx:2` `import * as echarts from 'echarts'`（1,096 KB）
- `src/renderer/src/App.tsx:3-10` 9 个页面全部静态 import；`React.lazy`/`Suspense`/`import()` 在 renderer 中 **0 处**
- 实测：`out/renderer/assets/index-*.js` = 4,261 KB；`index-*.css` = 661 KB

**改法**：`echarts/core` + 按需 `use([...])`；`React.lazy` 懒加载 `DashboardPage`/`MonitorPage`/`GrowthPage`/`SettingsPage`；`electron.vite.config.ts` 加 `build.rollupOptions.output.manualChunks` 做 vendor 拆分。预期首屏 JS 降到 ~2.5 MB 以下（**需实测**）。

---

## 2. P1 — 明显收益

### 2.1 主进程 / 数据库

| # | 位置 | 问题 | 改法 |
| --- | --- | --- | --- |
| 1 | `wechat/opsStats.ts:187` | 7 天窗口**无 LIMIT 全表扫**，全部行 `.all()` 进内存后 JS 循环；同步函数挂在 IPC 上 | 日/小时桶/方向下推 `GROUP BY`；大循环分块 + `setImmediate` 让出（`chatSyncRunner.ts:52` 有现成写法） |
| 2 | `db/repos/chatRepo.ts:101` | `listChatMessages` 无 LIMIT，被每轮对话/IM 回复/导出调用（预算其实只需 40 条） | 加 `listChatMessagesTail(sessionId, limit)`；feishu 取最后一条改一条 SQL |
| 3 | `db/database.ts:12` | 只设了 `journal_mode=WAL`；`foreign_keys` 未开（schema 里的 `ON DELETE CASCADE` **实际不生效**） | 补 `synchronous=NORMAL`、`busy_timeout=5000`、`cache_size=-16000`、`temp_store=MEMORY`、`mmap_size`；`foreign_keys=ON` 需先回归 |
| 4 | 全库 | `db.transaction` 命中 **0 次**；批量插入逐条提交（`issueRepo.ts:218`、`growth/warehouse/service.ts:116`、`growthBuzzRepo.ts:357`） | 用 `db.transaction()` 包裹；`analyzer.ts:943 applyExtracted` 整体包一层 |
| 5 | `wechat/schema.ts:65` | `getRowField` 慢路径每次 `new Map(Object.keys(row))`；可空列（`packed_info_data`/`server_id`）必然走慢路径，每条消息约 13 次调用 | 复用 `MessageTableColumns.lower`，或对行做一次小写键归一 |
| 6 | `wechat/content.ts:77/86` | `extractXmlValue/Attribute` 每次 `new RegExp`（59 个调用点；`parseChatHistory` 对每条记录调 18 次） | 按 tagName 记忆的 `Map<string, RegExp>`；`parseFileInfo` 按 localType 门控 |
| 7 | `wechat/queries.ts:837` | `listMessagesSince` 名为增量，实为「读最新一页再过滤」 | 加 `WHERE sort_seq > ?` 分支 |
| 8 | `media/mediaService.ts:57/97` | 每次媒体查找 `readdirSync` 缓存目录 + 3 份重复的 attach 树 DFS（`guard < 5000`），逐张图调用 | 抽一份 `walkFiles` + 进程级文件名索引；`readdirSync` 结果加 5 s 缓存 |
| 9 | `services/logging.ts:107/125` | 每条日志 `existsSync`+`statSync`+`appendFileSync`（3 次同步系统调用）+ 镜像 console | 文件大小用内存计数器；`createWriteStream` 替代逐条 append |
| 10 | `main/index.ts:136` | `ct-growth` 每个图片请求打一条 `info` 日志 | 降为 `debug` |
| 11 | `im/channelFiles.ts:126` | `pruneExpired` 每条文件记录一次 `getConfig` SQL | 账号保留天数缓存成 Map；过期判定下推 SQL |
| 12 | `ai/cap/registry.ts:140` | `listCaps()` 在每次工具调用路径重建数组 + 读配置 | 模块级 memo + `cs:config:set` 时失效 |
| 13 | `services/paths.ts:75` | `getCachePath()` 每次 `getConfig` + `existsSync` | 结果缓存，配置变更失效 |

### 2.2 渲染层

| # | 位置 | 问题 | 改法 |
| --- | --- | --- | --- |
| 1 | `DashboardPage.tsx:453-470` | `compSegs` 每次 render 新建 → `compDonut` 的 useMemo 永不命中 → `EChart.tsx:36` 每次 `setOption(notMerge:true)` 整图重建 | 给 `compSegs` 加 `useMemo` |
| 2 | `WorkbenchChatPage.tsx:1407-1434` | 流式尾块每帧（~60 fps）全量重跑 Markdown 解析，长回答接近 O(n²) | 流式期间渲染纯文本，块结束后再走 Markdown；或节流到 8~10 Hz |
| 3 | `MessagePanel.tsx:692` | 消息列表**无窗口化**（`locateIssueAt` 可加载到 750 条），且 `draft` 与列表同层 → 每敲一个字符重建整表 vdom | 复用 `WorkbenchChatPage` 的 `WB_WINDOW` 窗口化；输入区抽成 `Composer` |
| 4 | `stores/workbench.ts:242-250` | `sessions` 每次推送都换新数组，被 5 处订阅 → 相关页面全量重渲染 | 加浅比较，内容相同则 `return s` |
| 5 | `WorkbenchChatPage.tsx:1040-1047` | `useEffect` 无依赖数组，每次渲染都新建对象写 ref | 补依赖或用 `useCallback` |
| 6 | `WorkbenchChatPage.tsx:406-410` | `WbMessage` 比较器忽略 `meta`（reasoning/tokens/evidence） | 比较器补 `a.meta === b.meta` |
| 7 | `BuzzPanel.tsx:112-139` | `load()` 无请求序号 → 快速切筛选时慢响应覆盖新结果（**正确性问题**） | 照抄 `GrowthPage.tsx:1145` 的 `reqRef` 模式 |
| 8 | `BuzzPanel.tsx:359` | `useEscape(addOpen, () => setAddOpen(false))` 内联回调 → 每次渲染重挂监听 | `useCallback` 稳定（`GrowthAiWorkbench.tsx:310` 已这么做） |
| 9 | `WorkbenchChatPage.tsx:165` | `useWaitElapsed` 每秒触发整页 `setState` | 秒数抽成独立 memo 组件 |
| 10 | 多处 | index 作 key：`WorkbenchChatPage.tsx:1502`（附图按 index 删除，会闪旧图）、`GrowthAiWorkbench.tsx:219/694` | 改稳定 key |
| 11 | `main/db/repos/issueRepo.ts:375` | 问题列表**无 LIMIT** 全量过 IPC，渲染端关键词过滤无防抖 | SQL 加 LIMIT + 输入防抖 200 ms |

### 2.3 依赖与样式体积（最大的一块「免费」收益）**[已确认]**

| 包 | node_modules | src 引用 | 结论 |
| --- | --- | --- | --- |
| `gsap` | 5.97 MB | **0** | 删 |
| `framer-motion` | 4.61 MB | **0** | 删 |
| `@heroui/react` | 0.77 MB | **0** | 删 |
| `@heroui/styles` | 0.96 MB | 仅 `assets/tailwind.css:9` | 删 |
| `tailwindcss` + `@tailwindcss/vite` | — | 全仓 `@apply/@theme/@utility/@variant` **0 处**，className 中无真实 Tailwind 工具类（`st-grid`/`db-grid` 都是自定义类） | 可删 |

构建 CSS 661 KB 的分层实测：`components` 423 KB（HeroUI 全部组件样式，**零使用**）、`theme` 57 KB、`base` 33 KB、`utilities` 0.8 KB。删掉 Tailwind+HeroUI 链路后 CSS 可降到约 **144 KB（-78%）**，同时省掉每次启动的解析成本。

> 风险：Tailwind preflight 承担了一部分浏览器默认样式归一。`main.css:3-5` 已有 `box-sizing` 兜底，但删除后**必须目视回归**（表单/按钮/标题默认样式）。

### 2.4 CSS 质量（手写 11,132 行）

| 项 | 数据 | 位置/改法 |
| --- | --- | --- |
| **确认死规则** | **515 行**（dashboard 170 / settings 167 / growth 69 / workbench 63 / monitor 20 / workbench-chat 16 / im 9 / polish 1） | 选择器内类名在 53 个源文件零引用，已排除动态类名误报；按行号整段删 |
| **跨文件双写** | 66 个选择器，46 个属性被覆盖 | `growth-polish.css` 用「最后引入」压过 `growth.css`/`growth-ai.css`（如 `.gth-page{max-width:1560px}` 被 `max-width:none` 永久覆盖）；合并回基础文件 |
| **真 bug** | `.lg-lv.is-ERROR/is-WARN/is-INFO/is-DEBUG` | 数据源是**小写**（`logging.ts:16` + `LogSection.tsx:335`），标准模式类选择器大小写敏感 → 4 条规则永久失效，日志级别徽标全部退化为灰底 |
| 滚动区 `backdrop-filter` | 3 处（`growth-polish.css:143/167/434`） | 滚动容器内逐帧重新采样模糊；改半透明底 + 描边 |
| shimmer 动画 | `workbench.css:1968`、`growth-polish.css:333` | 动画 `background-position` 无法合成；改伪元素 `transform: translateX`（顺带修掉 `.gth-skel` 的 320px 截断） |
| `wb-flash` 动画驱动 `background` | `workbench.css:1893` | 改伪元素 opacity 动画 |
| `transition: all` | 2 处（`settings.css:22`、`im.css:65`） | 显式列属性 |
| 长列表无 `contain` | `will-change` **0 处**、`contain` **0 处**、`content-visibility` 仅 2 处 | 给 `.wb-msg/.wb-row/.lg-row/.mon-row` 加 `content-visibility: auto`，滚动容器加 `contain: layout paint` |
| 滚动条样式 | 4 处重复定义、`#c9cdd4` 硬编码 8 次 | 抽 `--sb-w`/`--sb-thumb` 到 `base.css`，省约 42 行 |
| 硬编码色 / 冗余 fallback / 未定义变量 | 237 处硬编码（29 处与 token 同值）、34 处 `var(--x, 硬编码)`、3 处用了未定义的 `--bg-1/--bg-card`、2 个死 token | `growth.css:956-958` 的 fallback 值（`#16a34a/#dc2626/#d97706`）与 token 实际值不符，属误导 |
| 注释乱码 | `settings.css` 22 行 GBK/UTF-8 双重编码 | 多数随死代码一起删除 |

CSS 可精简估算：**约 1,020 行（9.2%）**，激进约 1,300 行（11.7%）。

---

## 3. 冗余 / 死代码清单（可直接删）

| 项 | 数量 | 位置 | 可减行数 |
| --- | --- | --- | --- |
| 完全无引用的导出 | **41 处** | `ai/chat/service.ts:982 retryChat`、`wechat/injector.ts:41 focusWeChatWindow`、`ai/chat/skills.ts:420 runTool`、`issueRepo.ts:456 countByStatus`、`paths.ts:108-123 getTmpDir/getExportDir/getGrowthRootDir`、`logging.ts:63 logsDir`… | ≈400 |
| 整文件死代码 | 1 个 | `growth/collector/shareParser.ts`（58 行，0 importer，已被 `collector/resolver.ts` 取代） | 58 |
| 死 IPC 通道 | 8 个 preload 方法 + 10 个 handler | `keyStore.refresh`、`wx.stopWatch`、`issue.typeCounts`、`growth.adapters/analyzeContent/remixContent/recordPublish`、`growthai.updateOutput`；无 preload 的 `cs:reply:stopAll`、`cs:wx:listWatch` | ≈100 |
| preload 双份类型面 | 850 行 `index.ts` ↔ 693 行 `index.d.ts` | 已发生漂移（`index.d.ts:291` 精确类型 vs `index.ts:282` `unknown[]`；`index.ts` 共 34 处 `unknown`） | 300-450 |
| IPC 错误样板 | `err instanceof Error ? ... : String(err)` **60 次**、`catch` 90 处、`ok: false as const` 137 处、`ok/err` 辅助函数 3 份 | 抽 `ipc/result.ts` + `handle(channel, fn)` 包装 | 120-180 |
| 重复工具函数 | 时间格式化 10+ 份、`fmtBytes` 3 份逐字相同、`clip` 3 份、`sha1.slice(0,16)` 2-3 份、`safeJson` 2 份、`clampInt` 3 份逐字相同、JSON 花括号扫描 2 份、围栏剥离 4 份、剪贴板 4 份、目录遍历 7 份 | 分别收敛到 `shared/format.ts`、`shared/datetime.ts`、`shared/text.ts`、`shared/json.ts`、`main/services/fsWalk.ts`、`renderer/lib/clipboard.ts` | 200-300 |
| 重复 React 模式 | 38 处「挂载即 setState」（34 处标着「全仓同款模式」）、5 处手写 Esc、`App.tsx:139-167` 手写头像逻辑（`lib/sessionAvatar.ts` 已有）、3 份保存态三连 | `useAsyncData` / `useEscape` / `useAvatarUrl` / `useSaveState` | 200-300 |
| 重复类型定义 | `growthBuzzRepo.ts:7-45` ↔ `shared/growth.ts:250-299`（逐字相同）、`GrowthAiWorkbench.tsx:12-56` ↔ `growthAiRepo.ts:7-56`、`ChannelFileTray.tsx:10-24` ↔ `index.d.ts:210-219` | 提到 `shared/` | ≈110 |
| 重复实现的两套 Agent 引擎 | `ai/workbench/engine.ts`(569) 与 `growth/ai/growthEngine.ts`(172) 的 streamText 循环、tool 事件、历史构建、错误处理几乎相同 | 抽 `runToolLoop()` | 100-150 |
| 多余 `export` | 156 处只在本文件使用 | 去掉 `export`（不改行数，缩小 API 面） | 0 |
| 杂项 | `resources/icon.png` 与 `build/icon.png` SHA256 相同；`electron-builder.yml:51` 的 `publish: example.com` 无代码支撑；`tsconfig.web.json:4-7` 重复 include；`scripts/.tmp-plain/` **6.27 MB 解密后的真实微信库**（合规风险）；`scripts/*.mjs` 21 个 lint error | 清理 | ≈40 |

**合计**：可删除 ≈ 540 行，可收敛 ≈ 1,170–1,690 行，CSS 另可精简约 1,020 行。

---

## 4. 建议执行顺序（影响 × 成本）

| 批次 | 内容 | 预期收益 | 风险 |
| --- | --- | --- | --- |
| **第 1 批（半天）** | P0-1 解密新鲜度短路 + PBKDF2 缓存；P0-2 `locateWeChatDbs` 缓存 + `refreshSessions` in-flight 合并；P0-5 `stopSending` resolve | 主进程开库 82 ms → ~2 ms；卡顿的主要根因消除 | 低（10~40 行） |
| **第 2 批（半天）** | P0-4 store 不可变更新 → 再拆 selector；`TaskCard` memo；流式纯文本渲染 | 流式帧率、输入流畅度 | 中（必须按顺序，否则流式不刷新） |
| **第 3 批（半天）** | 依赖清理（gsap/framer-motion/@heroui/react/@heroui/styles/tailwind 链路）+ echarts 按需 + 页面 `lazy` | CSS −78%、首屏 JS −40% | 低-中（需目视回归） |
| **第 4 批（1 天）** | P0-6 issueRepo 索引+聚合；P0-3 跨页复用；P0-7 剩余分块；日志/媒体/opsStats 优化 | 监控页、群问题、看板响应 | 低 |
| **第 5 批（1-2 天）** | 死代码/死通道/重复函数收敛；CSS 死规则删除 + `growth-polish` 合并；preload 类型面收敛 | 可维护性，约 2,700 行减少 | 低-中 |

---

## 5. 需要实测验证的项

1. P0-1/P0-2/P0-3 的**绝对耗时**：本机库仅 2 MB；真实账号分片数百 MB 时 AES 项线性放大。建议在 `openWxDbFile` 打点统计「调用次数 × 单次耗时」。
2. 删除 Tailwind/HeroUI 后的**样式回归**（preflight 缺失影响）。
3. `content-visibility: auto` 引入后的**滚动条跳动**（与逐行 `animation-delay` 叠加）。
4. `PRAGMA foreign_keys = ON` 的历史孤儿行影响（现有代码依赖「外键未生效」手写 DELETE）。
5. `opsStats` 单次扫描行数、`issueRepo` 的 N/M 规模、`getRowField` 快慢路径命中率、`extractXmlValue` 重编译收益。
6. preload 类型面收敛后 `typecheck:web` 是否通过（需先补 34 处 `unknown`）。
7. `useAsyncData` 替换 38 处后各页加载态/竞态是否等价（部分组件自带 `seq` 防乱序）。

---

## 6. 补充：资源泄漏与小重复（P2）

| 位置 | 问题 | 改法 |
| --- | --- | --- |
| `main/index.ts:411-419` | `before-quit` 调了 6 个 `stop*`，**漏了 `stopFileHousekeeping`** → 6 小时定时清理器从不清理 | 补一行调用 |
| `feedback/scheduler.ts:133` | `addDbChangeHook(onDbChanged)` 返回的取消函数被丢弃；`stopAll()` 只重置标志位 → 下次 `ensure()` 再注册一次，`dbChangedHooks` 里累积永不清理的回调 | 保存 `uninstallHook` 并在 `stopAll` 调用 |
| `im/feishuService.ts:665/669` | 两条提前 `return` 未调用 `removeThinkingReaction` → `thinkingReactions` Map 条目永久留存，用户消息上的「思考中」表情不撤 | `try/finally` 包住整个 `handleInboundMedia` |
| `growth/scheduler.ts:35`、`im/channelFiles.ts:195` | `setTimeout` 返回值未保存，stop 时无法清除 | 保存句柄 |
| `report/chatSyncRunner.ts:184` | `if (!base) if (!base)` 同一条件写两遍 | 删一层 |
| `ai/chat/service.ts:1024` | 本地 `clearLastMessage` 与 `chatRepo.ts:175 popLastChatMessage` 等价 | 改 import |
| `db/repos/growthAiRepo.ts:203` | `listTasks` 每行 3 个相关子查询（`output_imgs` 还嵌套 + GROUP_CONCAT），最多 300 行 → 900+ 次子查询 | 改 `LEFT JOIN + GROUP BY` 或批量查后 JS 合并 |
| `db/repos/growthRepo.ts:215` | `ORDER BY json_extract(interactions_json,'$.likes')` 无法用索引，每页全表求值 + 排序 | 冗余成实体列或表达式索引 |
| `chatRepo.ts:243`、`issueRepo.ts:289` | 多步写（DELETE+INSERT / 两条 DELETE）无事务 | 包 `db.transaction()` |

---

## 7. 落地记录（本次已实施）

> 全部改动已通过 `npm run typecheck`（node + web）、`npm run build`、`npx eslint --no-cache .`
> （error 53 → 52，warning 157 → 117，无新增 error）。

### 7.1 构建产物体积（实测，同一台机器）

| 指标 | 改动前 | 改动后 | 变化 |
| --- | --- | --- | --- |
| 首屏 JS（单 chunk） | 4,261 KB | **1,128 KB** | **−73%** |
| 首屏 CSS | 661 KB | **91 KB** | **−86%** |
| CSS 总计 | 661 KB | 197 KB（按页拆分） | −70% |
| echarts | 打进首屏 | 独立 chunk 1,362 KB，**仅打开看板/监控时加载** | 首屏不再承担 |
| 代码分割 | 无 | 6 个页面 lazy + echarts 独立 chunk | 新增 |

### 7.2 主进程

- `decrypt.ts`：明文副本 mtime/size 新鲜度短路 + PBKDF2 结果缓存（单次开库 82ms → ~2ms；实测 PBKDF2 72ms/次）。
- `dbLocator.ts`：`locateWeChatDbs` 30s 缓存 + `findFileCached` 60s 缓存 + `invalidateWxPathCaches()`，由 `watchService.broadcast` 精确失效；`queries.ts` 的 `findContactDb`/`findDbFileByName` 合并为一份 `walkFindDbFile` 并接入缓存。
- `queries.ts`：`listMessagesSince` 改为 SQL 侧 `WHERE sort_seq > ?`；按 localType 门控解析（imageMd5/图片/语音/文件）。
- `content.ts`：`extractXmlValue/Attribute` 正则编译缓存（59 个调用点）。
- `schema.ts`：`getRowField` 行级小写键 WeakMap 缓存。
- `logging.ts`：日志文件大小内存计数（不再每条 3 次同步系统调用）；`ct-growth` 每请求日志降为 debug。
- `mediaService.ts`：3 份 attach 目录 DFS 合并为 `walkFiles` + 进程级文件名索引；缓存目录 readdir 加 5s TTL。
- `opsStats.ts`：改 async + 每 4000 行 `setImmediate` 让出事件循环（不再长时间冻结主进程）。
- `database.ts`：补 `synchronous=NORMAL`/`busy_timeout`/`cache_size`/`temp_store`/`mmap_size`。
- `schema.ts`：新增 3 个索引（`issue_feedback(wxid,status,occur_at)`、`(wxid,group_username,status)`、`issue_feedback_msg(issue_id,seq)`）。
- `issueRepo.ts`：`listIssues/searchIssues/openIssuesForGroup/listIssuesByGroup` 的 N+1（每行 COUNT + 每行读配置）改为一次批量聚合；`upsertIssue` 消息重建包事务。
- `analyzer.ts`：`applyExtracted` 整批包事务；`growth/warehouse` 素材写入、`growthBuzzRepo` 评论标记同样包事务。
- `chatRepo.ts`：新增 `lastAssistantText`，feishu 回复不再读全量历史。
- `paths.ts`：`getCachePath` 结果缓存 + `cs:config:set` 失效。
- `ai/cap/registry.ts`：`listCaps` 按 `cap.disable` 配置缓存。
- `send/sendService.ts`：`stopSending` 现在会 resolve 队列中的任务（此前渲染端 await 永久挂起）。
- 泄漏修复：`before-quit` 补 `stopFileHousekeeping`；`feedback/scheduler` 保存并调用 `addDbChangeHook` 的取消函数；feishu 媒体处理改 `try/finally` 清理 `thinkingReactions`；`cs:wb:remove/removeAll` 补 `dropSession`。
- `channelFiles.pruneExpired`：保留天数按账号缓存，不再每行一次 SQL。

### 7.3 渲染层

- `workbenchChat.ts`：`appendTurnToken` 改为不可变更新（新数组）——**这是拆 selector 的前置条件**。
- `WorkbenchChatPage.tsx`：全 store 订阅 → 15 个细粒度 selector；流式尾块改用纯文本渲染（块结束才走 Markdown）；`WbMessage` 比较器补 `meta`；`openPrompt/createChat/exportCurrent` 稳定化 + effect 依赖数组。
- `GrowthAiWorkbench.tsx`：`TaskCard` 加 `memo` + `removeTaskStable` 稳定回调；流式气泡抽成 `StreamBubble`。
- `MessagePanel.tsx`：消息行元素 `useMemo` 缓存（输入草稿变化不再重建数百个元素）。
- `DashboardPage.tsx`：`compSegs`/`compTotal`/`todayActive` 提进 `useMemo`（图表不再每次渲染整图重建）。
- `BuzzPanel.tsx`：`load()` 加请求序号防竞态；`useEscape` 回调稳定化。
- `GrowthPage.tsx`：链接入库条抽成 `IngestBar`（输入草稿内聚，不再每键重渲染 100 行素材表）。
- `workbench.ts`：`refreshSessions` in-flight 合并 + `sessions` 浅比较（内容不变不换引用）。
- `EChart.tsx`：echarts 改按需注册（Bar/Line/Pie + Grid/Legend/Tooltip/Graphic + Canvas）。
- `App.tsx`：6 个非首屏页面 `React.lazy` + Suspense。

### 7.4 依赖与 CSS

- 删除零使用依赖：`gsap`、`framer-motion`、`@heroui/react`、`@heroui/styles`（node_modules −11.4 MB）。
- `tailwind.css` 移除 `@import '@heroui/styles'`（HeroUI 全量组件样式 423 KB，零组件使用）；
  **保留** `@import 'tailwindcss'`（preflight/theme，约 90 KB）——删除它会改变浏览器默认样式归一，需目视回归后再决定。
- 死规则删除 99 条 + 孤儿注释 17 条；`growth-polish.css`（735 行）按选择器前缀合并进 `growth.css`/`growth-ai.css` 后删除。
- 性能属性：`transition: all` ×2 → 显式属性；滚动区 `backdrop-filter` ×3 去除；骨架屏 shimmer 改伪元素 `transform`；`wb-flash` 改伪元素 opacity；补齐 `wb-run-pulse`/`wb-row-in` 消除跨文件 keyframes 依赖；滚动条样式收敛到 token。
- 长列表：`.wb-msg/.wb-row/.lg-row/.mon-row` 加 `content-visibility: auto`；`.wb-chat-body/.wb-body/.lg-list` 加 `contain: layout paint`。
- 修掉 `.lg-lv.is-ERROR` 大小写不匹配（4 条规则此前永久失效）。

### 7.5 死代码与重复

- 删除 23 个零引用导出 + 2 个级联死函数 + 整文件 `shareParser.ts`；删除 8 个渲染层零调用 IPC 通道（preload 方法 + d.ts 声明 + main handler）与 1 个孤儿 handler。
- 收敛重复实现：`clampInt`×3、`safeJson`×2、`sha1Of`×2、`errText`×2、`safeFileName`×4 → 5 个共用模块；43 段逐字相同的 IPC catch 样板 → `fail()`。
- 清理孤儿：`watchService.stopWatch/listWatchWxids`、`keyStoreService.refreshKey`、`analyzer.issueTypeCounts`、`feedback/scheduler.remove`、`registry.lookupCap/isCoreCapability`。

### 7.6 明确未做（附原因）

1. **preload 双份类型面（850 行 `index.ts` ↔ 693 行 `index.d.ts`）**：收敛需先把 `index.ts` 里 34 处 `unknown` 补成精确类型，属独立重构，且当前两份已能通过编译，风险大于收益。
2. ~~**`growth/remix/service.ts` + `prompts.ts`（约 315 行）**：`remixContent` 已无调用方，但整条"爆改"链疑似为规划中的功能，保留待产品确认，未删。~~
   → **已删（2026-09）**：核实 `remixContent` 全仓零调用方，且「营销 → AI 工作台」已用 `growth_rewrite_title/copy + growth_update_output`（写 `growthAiRepo`）承接同一件事，
   两份实现并存只会漂移。本轮删除：`service.ts` 的 `remixContent`+`ensureDecompText`、`prompts.ts` 的 `buildRemixPrompt`/`normalizeRemixResult`/`STYLE_LABEL`、
   `growthOpsRepo` 的三个写函数（`createRemixJob`/`finishRemixJob`/`createRemixOutput`）、`shared/growth.ts` 的 `GrowthRemixStyle`。
   产物：`service.ts` 178→103 行、`prompts.ts` 146→83 行、`growthOpsRepo` −50 行。
   **历史数据的读取路径保留**（`listRemixOutputViews` 仍被页面与导出器使用），需要恢复该链路见 git 历史。
3. **删除 Tailwind 本体**：见 7.4，需目视回归。
4. ~~**`issueRepo` 列表 SQL 加 LIMIT / `cs:wb:messages` 分页**：会改变 IPC 契约与渲染端分页行为，建议单独排期。~~
   → **已核实：不加（2026-09）**。理由：
   - `listChatMessages(sessionId)` 有 **10+ 个调用方**，其中一半在**主进程引擎**里（`ai/chat/service`、`workbench/engine` ×3、`growthEngine`、`wechatClawService`）——
     它们是拿全量消息去做**上下文构建/压缩**的，在仓储层加 LIMIT 等于悄悄改掉模型看到的上下文（压缩逻辑在引擎里，已有明确策略）。
     真要治理「超长会话」，正确的口子是引擎的上下文预算，而不是给 SQL 加一个全局上限。
   - `listIssues(wxid)` 确实没有 LIMIT，但议题是「按群分析出的问题」量级（本机当前 58 条），
     加 LIMIT 反而会让监控页**静默少显示**（没有分页 UI 承接）。
   - 已有按需分页的现成口子：`listChatMessagesTail(sessionId, limit)`、渲染端消息 keyset 翻页、`listIssuesByGroup` 的群级视图。
   结论：这条从「待办」改成「**按需再说**」——等真出现某个群/某会话数据量异常，再针对那一条路径做分页（并配套 UI），
   不做「全局加个 LIMIT」这种既改契约又可能丢数据的动作。
5. **`settings.css` 等文件里双重编码乱码注释**：只删了随死代码一起消失的部分，全量重写属独立清理。

---

## 8. 值得保留的既有优化（不要动）

- `WorkbenchChatPage`：消息窗口化、历史气泡 memo + 自定义比较器、插件数组模块级常量、delta 按 rAF 合并 + 轮次号丢弃迟到帧、滚动跟随用 ref。
- `MessagePanel`：`MessageBubble` memo + 稳定回调；头像/红包请求有缓存与 in-flight 去重。
- `SessionList`：`SessionItem` memo + 稳定回调；badge 用原始值 selector。
- `MonitorPage`：派生数据与图表 option 全部 `useMemo`；详情请求有序号防竞态。
- `opsStats`：60 s 缓存 + dbChanged 失效 + 1.5 s 节流，是「缓存该怎么做」的现成模板。
- `chatSyncRunner`：分页扫描期间跳过 enrich、按会话让出事件循环。
- 全仓无注释掉的代码块、无 TODO/FIXME、`any` 仅 12 处、`@ts-ignore` 仅 2 处。
