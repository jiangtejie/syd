# 全项目设计/冗余/技术债审计（2026-09-12）

> 范围：`src/` 全部 279 个文件（21.2 万行：ts 212 个 44,557 行、tsx 52 个 19,985 行、css 15 个 10,256 行）+ 构建产物 + 依赖。
> 方法：静态交叉验证（类名存活检测、同名函数统计、CSS 选择器重复度、构建产物体积、lint 基线）+ 关键路径实读。
> 上一份审计见 `docs/performance-audit.md`（2026-09-09，性能向）；本文聚焦**设计精简 / 冗余合并 / 技术债与审美债**。

## 0. 基线（本轮实测）

| 项                   | 实测                                                                                                         | 评价                                                                                      |
| -------------------- | ------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------- |
| typecheck            | 0 error                                                                                                      | ✅                                                                                        |
| eslint               | **0 error / 0 warning**（本轮前 78 条 prettier 告警，已 `--fix` 清空）                                       | ✅                                                                                        |
| 构建产物             | `index.js` 1.19 MB · `vendor-echarts.js` 1.39 MB · 各页面已按路由分块                                        | 可接受；图表库是大头                                                                      |
| CSS 类总数           | 1081 个；**真正无人使用的规则 0 条**                                                                         | ✅ 比预期干净（早先疑似「未使用」的 13 个经核实都是动态拼类名/ Markdown 生成 / 注释残留） |
| UI 类族              | **13 套**（`gth-`16 `mon-`12 `db-`9 `dt-`8 `st-`7 `sf-`5 `exp-`4 `gip-`3 `cu-`2 `wb-`/`lg-`/`page-`/`gai-`） | ⚠️ 审美债核心                                                                             |
| 跨文件同名选择器     | 40 个（`.primary` `.ghost` `.danger` `.is-active` `.sm` `.t` …）                                             | ⚠️ 变体命名没统一                                                                         |
| `eslint-disable`     | 61 处（最多 6 处/文件，主要是 `set-state-in-effect` 约定）                                                   | 🟡 可接受，但可收敛                                                                       |
| TODO/FIXME           | **0 处**                                                                                                     | ✅                                                                                        |
| `@ts-ignore` / `any` | 2 处（preload 的 `define in dts`，惯用法）/ 1 处（读库层 `getRowField`）                                     | 🟡 已把 2 处 `catch (e: any)` 收窄                                                        |

## 1. 结论：够不够精简？

**已经很好的部分**（不用动）：

- 没有引入 UI 组件库（HeroUI 已移除，零使用却曾整包引入 423 KB 样式）；
- 共享层划分清晰：`shared/`（类型 + 纯函数）、`main/services/*`（按领域分目录）、`renderer/lib`（纯工具）、`components/*`（按页面分目录）；
- 纯函数都有离线自检（`scripts/*-selftest.mjs` 11 套），业务口径不容易悄悄漂移；
- TODO 为 0、死文件为 0（仅两个 `.d.ts` 无引用属正常）。

**真正的冗余集中在四处**：

### 1.1 UI 类族 13 套（审美债第一）

每个页面自带一套按钮/输入/卡片/徽标：`.gth-btn` `.mon-btn` `.db-*` `.dt-btn` `.st-btn` `.sf-switch` `.exp-*`…
结果是同一件事在不同页面长得不一样（按钮圆角/高度/悬停色各写一份，`.primary/.ghost/.danger` 在 4~6 个文件里各定义一次）。
`sf-*`（设置页那套：卡片/开关/胶囊）事实上已是**最新、最完整的设计系统**。

**建议（P1，分页做，不一次性重写）**：把 `sf-*` 提升为全局 `ui-*`，写进 `base.css`；每迁移一个页面就删掉该页的按钮/输入定义；
优先做**小而完整**的页面（导出页 `export.css` 279 行、值班 `duty.css` 321 行）当试点，再动巨型文件。

### 1.2 巨型文件（可维护性债）

| 文件                                         | 行数        | 问题                                            |
| -------------------------------------------- | ----------- | ----------------------------------------------- |
| `pages/SettingsPage.tsx`                     | 2280        | 8 个 tab、20+ 卡片、4 组独立状态挤在一个组件里  |
| `pages/GrowthPage.tsx` + `growth.css`        | 1986 + 1932 | 营销域自成体系（与主应用设计语言不一致）        |
| `pages/workbench.css` / `workbench-chat.css` | 2128 / 1667 | 工作台样式没有分层                              |
| `main/services/lark/baseSync.ts`             | 1675        | 引擎 + 三张表同步 + 冲突回写 + 附件都在一个文件 |
| `preload/index.ts` + `shared/api.ts`         | 1196 + 1097 | **同一套 API 签名写了两遍**                     |

**建议（P1）**：

- `SettingsPage`：按 tab 拆成 `settings/` 下 8 个 Section 组件（每个 100~300 行），页面只留 tab 与共享状态；
- `baseSync.ts`：抽出 `baseWrite`（记录增改/冲突列/限流）与 `syncIssues` / `syncReplies` / `syncEvidence` 三个文件；
- **preload 与 api.ts 去重**：让 preload 的导出对象带 `satisfies PreloadApi`，签名只留一份 —— 现在加一个 IPC 要改三处，漏一处在运行期才炸（本轮就踩到过一次）。

### 1.3 同名工具函数多份实现

静态统计出 25 组同名函数，其中**真正该收敛的**：

- `fmtTime` **6 份** → 本轮已把主进程 5 份统一到 `shared/monitorMetrics` 的 `fmtStamp`（顺带修掉格式不一致：有的 `9月12日 15:20:33`、有的 `2026-09-12 15:20:33`）；
- `listFields` 3 份（`api.ts`/`baseSync`/`baseSystem`）：都是飞书字段列表，可合并成一个带缓存的工具；
- `parseLlmJson` 2 份、`scoreOf` 2 份、`startOfDay` 2 份、`ageText` 2 份、`clip` 4 份、`extOf` 3 份 → 属**不同领域的小工具**，收敛收益低，暂不动（写进本文件备查）。

### 1.4 功能层面的两个入口重叠

- **数字员工**：客户页（按群批量开关）与值班页（总开关/话术/决策记录）操作的是**同一份状态**（都走 `cs:duty:*`）。
  本轮在客户页加了「话术与决策记录 →」跳转，明确分工；不建议合并页面（批量 vs 总览是两个使用场景）。
- **看板 vs 监控**：两者都在讲 KPI 与趋势 —— 监控页聚焦「问题」，看板页聚焦「数据采集状态 + 新鲜度」。
  命名容易混（导航上「监控」「看板」并列）。建议二选一：① 把看板并进监控做第二个 tab；② 看板改名「数据状态」。**需你拍板**。

## 2. 技术债清单

| #   | 项                                             | 现状                                                                                                                                                                 | 建议                                                   | 优先级         |
| --- | ---------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------ | -------------- |
| T1  | preload / api.ts 签名写两遍                    | **勘误**：preload 已经是 `const api: PreloadApi = {…}`，漏加/漏改会**编译期报错**（不是运行期），一致性有保障；剩下的只是「1196 行里手抄了一遍返回类型」的可读性问题 | 想瘦身可让 TS 走上下文推断（收益小、改动面大，暂不做） | P3             |
| T2  | `tailwindcss` 仅用于 preflight                 | 全项目 0 处工具类；删它要逐页核对控件/标题默认样式                                                                                                                   | 要么删掉换 30 行手写 reset，要么在新页面真的用起来     | P2             |
| T3  | `eslint-disable` 61 处                         | 主要是 `set-state-in-effect`（React 19 约定）                                                                                                                        | 抽 `useSyncedEffect` 之类的小 hook 可减半              | P2             |
| T4  | 读库层 `getRowField(row: Record<string, any>)` | 微信库列名动态，宽类型历史遗留                                                                                                                                       | 单独排期收窄（文件头已注明）                           | P3             |
| T5  | `scripts/.tmp-plain/` 6.27 MB                  | **解密后的真实微信库**（合规风险，已在上一份审计里标注）                                                                                                             | 确认无需复现后删除；或移出仓库目录                     | **P1（合规）** |
| T6  | 图表库体积 1.39 MB                             | 已按需注册（core + 3 图 + 4 组件），无全量桶导入                                                                                                                     | 想再瘦身只能换图表库或减图型，收益/成本不划算          | P3             |

## 3. 审美债清单

| #   | 项                   | 说明                                                                                                |
| --- | -------------------- | --------------------------------------------------------------------------------------------------- |
| A1  | 13 套 UI 类族        | 见 §1.1；建议按页迁移到统一 `ui-*`                                                                  |
| A2  | 硬编码颜色           | 图表色 `#07c160/#5b8ff9/#fa5151` 在 `DashboardPage` 里当常量；页面里仍有少量硬编码 px 圆角/间距     |
| A3  | 注释与实现不符       | `main.css`/`tailwind.css` 仍在讲已删除的 HeroUI 与 `.button--primary`（本轮已改写为实际的分层说明） |
| A4  | 相对时间 vs 绝对时间 | 已统一（`docs/time-format-convention.md`），但新代码需要持续守约                                    |
| A5  | 徽标/状态语义色      | `is-*` 命名在 10 个文件里各自定义（`.is-active` 重复 10 次）→ 随 A1 一起收敛                        |

## 4. 本轮已执行（都过了 typecheck / lint / build + 自检）

1. **格式债清零**：`npx eslint . --fix`，78 条 prettier 告警 → **0**（eslint 现在完全干净）；
2. **时间口径收敛**：删掉主进程 5 份 `fmtTime` 本地实现（agentTools / software / skills / notify / chatSyncRunner），统一到共享 `fmtStamp`；
3. **类型收窄**：`queries.ts` 两处 `catch (e: any)` → `catch (e)` + `errText()`；
4. **注释与实现对齐**：`main.css` 的 HeroUI 说明、`tailwind.css` 的「新增页面用 Tailwind 工具类」改为当前事实（只为 preflight 保留，附待办）；
5. **功能入口去重**：客户页加「话术与决策记录 →」跳转值班页，明确「批量开关 vs 总览」分工（含样式）；
6. 复核：CSS 无死规则、无死文件、TODO 为 0（都不是「我以为」，是静态扫描 + 实读确认）。

## 4.1 第二轮：结构性优化（本轮已做，全部过 typecheck / eslint / build / 自检）

| #   | 做了什么                                                                                                                                                                         | 结果                                                                                                              |
| --- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| 1   | **删掉 `scripts/.tmp-plain/`**（6.27 MB 解密后的真实微信库）                                                                                                                     | 合规风险解除；目录本就在 .gitignore 里，需要复现时用 `scripts/wx-verify.mjs` 重新生成                             |
| 2   | **拆 `SettingsPage`**：把「议题同步 + 议题证据明细」两张卡片（20+ 状态、15 个动作）整体搬到 `components/settings/LarkBaseSyncSection.tsx`                                        | **2302 行 → 1333 行**（−42%），新组件 954 行；对外只依赖一个 `reloadKey` prop，靠 typecheck 保证搬移无损          |
| 3   | **统一控件基元**：在 `assets/base.css` 新增 `ui-btn / ui-input / ui-select / ui-tab / ui-pill / ui-link`（含 `is-primary/is-danger/is-active/is-on` 状态），并**试点迁移导出页** | 导出页 JSX 改用 `ui-*`、`export.css` **279 行 → 177 行**（−37%），页面只留布局；已用真实 CSS 渲染截图核对外观     |
| 4   | **信息架构定名**：「看板」→「**运营看板**」（导航 + 窗口标题 + 页面标题）                                                                                                        | 勘误：原建议「改名数据状态/并进监控」不准确 —— 该页是运营指标+跟进队列+审计，与「问题监控」是两件事，合并会丢信息 |
| 5   | **勘误 T1**：preload 本就是 `const api: PreloadApi`，签名漂移是编译期报错                                                                                                        | 技术债降级为 P3（可读性），不再列为 P1                                                                            |

> 迁移方法论（供后续页面照做）：**先在 base.css 定义 `ui-*` → 页面 JSX 加类名 → 删掉该页重复的外观规则，只留布局**；一次一页、逐页提交，
> 每页用真实 CSS 渲染截图核对（本轮导出页就是这么验的）。

## 5. 建议的下一步（按性价比排序，需你点头的已标注）

| 顺序 | 事项                                              | 收益                                                                                                                       | 风险                                 | 需要拍板 |
| ---- | ------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- | ------------------------------------ | -------- |
| 1    | 删/移 `scripts/.tmp-plain` 真实微信库             | 合规                                                                                                                       | 低（确认无需复现即可）               | ✅       |
| 2    | preload 用 `satisfies PreloadApi`                 | 以后加 IPC 只改一处                                                                                                        | 中（会暴露已有签名不一致，需逐个修） | ✅       |
| 3    | `SettingsPage` 按 tab 拆分                        | 2280 行 → 8 个 200 行文件                                                                                                  | 中（纯搬移，靠 typecheck 兜）        | ✅       |
| 4    | UI 类族统一到 `ui-*`（按页迁移，先小页面试点）    | 视觉一致 + CSS 减量                                                                                                        | 中（需目视核对，建议逐页提交）       | ✅       |
| 5    | ~~看板 / 监控 关系定名或合并~~ → **已做（改名）** | 见 §4.6：看板页实际是「运营指标 + 跟进队列 + 会话/发送审计」，既不是「数据状态」也不该并进问题监控，最终改名为**运营看板** | ——                                   | ✅       |
| 6    | `baseSync.ts` 拆文件                              | 可维护性                                                                                                                   | 中                                   | ——       |

## 4.2 第三轮：UI 类族迁移 + 去掉 Tailwind（已做，全部过 typecheck / eslint(0/0) / build / 自检）

### 迁移到全局 `ui-*` 的页面

| 页面 | 之前 | 之后 | 说明 |
| --- | --- | --- | --- |
| 导出页 `export.css` | 279 行 | **177 行** | 按钮/输入/下拉/页签/胶囊/链接 全部改走 `ui-*`，本页只留布局 |
| 值班页 `duty.css` | 321 行 | **244 行** | 同上；页签由「下划线式」统一成 `ui-tab` 胶囊式 |
| 客户页 `customers.css` | 449 行 | **419 行** | 翻页条 3 个控件 + 「数字员工」开关(→`ui-pill`) |
| 监控页 `monitor.css` | 699 行 | **679 行** | 工具栏按钮（含 primary/danger）+ 输入/下拉 |
| 工作台右栏 `workbench.css` | 2453 行 | 2440 行 | 群问题面板 6 个按钮（含 primary/ghost/danger） |
| 全局 `base.css` | 89 行 | ~240 行 | 新增 `ui-btn / ui-input / ui-select / ui-textarea / ui-tab / ui-pill / ui-link`（含状态变体）——**一套顶十三套** |

> 页面级类名保留下来只承载**布局与密度**（例：`.mon-btn { padding: 4px 10px }`、`.cu-pager-btn { height: 26px }`），
> 外观一律来自 `ui-*`。这就是后续每页迁移的统一手法：**JSX 加 `ui-*` → 删掉该页外观规则 → 保留布局**。

### 仍未迁移（剩下的都是「专用控件」而非重复实现）

- `growth.css` 43 条控件规则（`gth-btn/seg/select/input/chip`，含 `.sm/.solid` 变体）→ 下一轮按同一手法迁移；
- `growth-ai.css` 6 条（`.gai-input`）；
- `dashboard.css` 的 `.db-seg`（分段控件）与 `.db-chip`（徽标）、各类 `.is-*` 状态徽标 → 属于「组件」而非「重复的按钮」，建议保留但统一命名；
- `workbench-chat.css` 仅 1 条（`.wb-side-foot .st-btn`）。

### 去掉 Tailwind（依赖 → 手写 reset）

审计结论：Tailwind 在本项目**只为 preflight 存在**（全项目 0 处工具类、0 个组件库）。本轮把它换成了自写的
`src/renderer/src/assets/reset.css`（约 120 行，逐条对齐 Tailwind v4 preflight 的四类归一：盒模型/边框基线、
标题与列表的默认边距、表单控件外观、媒体与链接默认样式），并：

- 入口 `main.tsx` 改为 `import './assets/reset.css'`；
- `electron.vite.config.ts` 去掉 `@tailwindcss/vite` 插件；`package.json` 去掉 `tailwindcss` + `@tailwindcss/vite`；
- 删除 `assets/tailwind.css`；
- 构建产物 CSS：`index.css` 101,859 → **97,677 字节**（-4.1KB preflight），全项目 CSS 合计 ~216KB；
- 验证：用真实 CSS 渲染「裸元素（按钮/链接/标题/列表/段落）+ `ui-*` 控件 + 各页已迁移控件」的对照页截图核对，
  裸元素已无边框/圆点/外边距，控件外观正常。

> ⚠ 这是本轮**唯一**「验证到 harness 级别、没逐页目视」的改动：如果有页面出现默认样式回归（例如某处裸 `<ul>` 出现圆点、
> 某处裸 `<button>` 变灰底），把 `main.tsx` 的第一行改回 `import './assets/tailwind.css'` 并恢复依赖即可回退（reset.css 保留不影响）。

## 4.3 第四轮：结构拆分 + 控件族收敛（本轮已做，全部过 typecheck / eslint(0/0) / build / 自检）

### 1. `baseSync.ts` 拆成三层（技术债 #6，本轮最大的一块）

| 文件 | 行数 | 装什么 |
| --- | --- | --- |
| `src/main/services/lark/baseCore.ts` | 671 | 配置键、字段定义(ISSUE/EVIDENCE/REPLY_FIELDS)、链接解析、列名映射、Base/表/字段读写原语(`findTable/listFields/ensureFields/ensureTable`)、结果类型、历史环 |
| `src/main/services/lark/baseEvidence.ts` | 457 | 议题证据子表：配置、按需建表、每议题挑选(`pickPerIssue`)、append-only 推送、图片证据上传成附件、孤儿行清理 |
| `src/main/services/lark/baseSync.ts` | 694（原 1826） | 议题推送/回拉、回复影子记录、状态与历史、一句话提示 |

- 依赖方向 **baseCore ← baseEvidence ← baseSync**，只向上依赖，因此不会循环引用；`baseSync` 末尾用 `export … from` 转发，
  **对外模块表面完全不变** —— `src/main/ipc/larkHandlers.ts` 一行都不用改（typecheck 兜住了这一点）。
- 搬移无损的证据（不是「感觉没问题」）：用脚本把 HEAD 版 `baseSync.ts` 与拆分后的三个文件按声明逐个比对 ——
  **94 个声明里 93 个逐字节相同**，唯一差异是 `pickPerIssue` 的泛型签名被 prettier 换行。
- 顺带修掉一个隐患：`syncRepliesOut` 里注释提到 `verifyBaseLink` 导致自动生成的 import 多带一个未使用符号（eslint 会报），已收敛。

### 2. 控件族收敛：`.st-btn` 家族（A1/A5 最大一块）

- `.st-btn` 定义在 `settings.css`，却被 **15 个文件、105 处**调用（设置页/工作台/IM/渠道文件/报表…）——
  既是重复实现，也是「页面 CSS 定义共享类」的架构错位。
- 统一映射到 `ui-btn`：`ghost`→默认（次要操作）、无修饰→`is-primary`（主操作）、`danger`→`is-danger`(+ `is-solid` 实心红)、
  `sm`→`is-sm`；`settings.css` 删除 57 行外观规则，页面只留布局（如 `.sf-actions-split .is-end`）。
- 新增两个基元补全设计系统：`ui-btn.is-sm / .is-solid`、`ui-chip`（语气 `is-ok/is-warn/is-bad` + `is-solid/is-line/is-sm`）、
  `ui-seg`+`ui-seg-btn`（互斥分段控件，`.is-on`）。
- 顺带迁移：`dashboard.css` 的 `.db-seg/.db-chip`（−59 行）、`customers.css` 的 `.cu-tag-chip`（−17 行）、
  `workbench-chat.css` 最后 1 条 `.st-btn`。发送结果的四种 chip 收敛成 `ok/warn/bad` 三档语气（`halted` 与 `failed` 同为红）。
- 核对方式仍是「真实 CSS 渲染 + 截图」：把 `reset.css + base.css` 直接挂到一张对照页，渲染
  8 种按钮 / 7 种 chip / 分段控件 / 设置卡片与右栏底宽按钮两处旧排版，目视确认后删除临时页。

### 3. 注释乱码（A3）清零

- 发现 `settings.css / monitor.css / shell.css / workbench.css` 共 **26 行注释是 UTF-8 字节被当 GBK 解读**的乱码
  （例：`/* 鈹€鈹€ 缇ら棶棰橀潰鏉匡細… */`）。
- 修复路径可逆：把乱码字符按 GBK 反向映射回字节、再按 UTF-8 解码 —— 18 行自动还原成功；
  另 8 行因早期转换丢过一个字节（留下 `?`）无法自动还原，按残句手工重建。
- 现状：全仓库（src/docs/scripts，324 个文件）**乱码 0 行**。

### 4. 顺手清理

- `.gitignore` 加 `*.tsbuildinfo`（`npm run typecheck` 会生成 composite 缓存，之前是未跟踪噪声）；
- 删除遗留临时脚本 `scripts/.tmp-forms.cjs`。

### 5. 巨型 CSS 文件分段（本轮第二批）

| 原文件 | 行数 | 拆成 |
| --- | --- | --- |
| `pages/workbench.css` | 2453 | 外壳 24 行 + `pages/workbench/` 下 7 节：scrollbars 8 / list 196 / messages 751 / side 326 / overlays 172 / issues 465 / misc 481 |
| `pages/workbench-chat.css` | 1917 | 外壳 14 行 + `pages/workbench-chat/` 下 5 节：layout 345 / messages 436 / interactions 334 / richtext 571 / files 213 |
| `pages/growth.css` | 2033 | 外壳 8 行 + `pages/growth/` 下 5 节：forms 302 / tables 332 / panels 167 / buzz 648 / polish 681 |

- **踩到的坑（记下来免得再犯）**：一开始用 CSS 的 `@import` 做聚合 —— Vite 实测**直接丢弃**了这些 `@import`
  （外壳文件里 `@import` 前面还有规则，且构建产物里 `gth-btn`/`wb-sessions` 全部消失，产物从 90KB 掉到 19KB）。
  改成**由消费方模块按顺序 import 分节文件**（`Workbench.tsx` / `WorkbenchChatPage.tsx` / `GrowthPage.tsx` 顶部各加一组样式导入），
  构建后逐项核对：`wb-sessions`/`wb-side-foot`/`gth-btn`/`gth-card`/`gai-page` 全部存在、产物里 `@import` 残留为 0、`.st-btn` 为 0。
- **保序/无损的证据**：脚本把 HEAD 版与「外壳 + 各分节」的纯声明序列（去掉注释与空行）逐行比对 ——
  workbench **2035 行完全相同**、workbench-chat **1615 行完全相同**、growth **1997 行完全相同**。

### 6. 巨型组件分段：`GrowthPage.tsx` 2147 行 → 8 个文件（本轮第三批）

| 文件 | 行数 | 装什么 |
| --- | --- | --- |
| `pages/GrowthPage.tsx` | 183（原 2147） | 只留页面外壳：页签 + 各面板拼装 + `TAB_DESC` |
| `components/growth/meta.ts` | 68 | 纯数据/纯函数：`growthApi`、`fmt/fmtRel/fmtNum`、四张文案映射表、remoteMedia 取址函数 |
| `components/growth/common.tsx` | 138 | 通用小组件：`Switch / Badge / SearchInput / EmptyState / ErrBar` |
| `components/growth/StatsBar.tsx` | 118 | 指标条 + 4 个图标 |
| `components/growth/ProviderPanel.tsx` | 137 | 数据服务商面板 |
| `components/growth/SourcesPanel.tsx` | 420 | 订阅源面板（含新建/编辑表单状态） |
| `components/growth/MediaGallery.tsx` | 266 | 图集画廊 + 灯箱 |
| `components/growth/WarehousePanel.tsx` | 870 | 素材仓库面板（入库条 + 详情 + 批量操作） |

- **无损证据**：脚本按声明名比对 HEAD 版与拆分后 8 个文件 —— **41 个声明一个不少**，其中 37 个逐字节相同，
  4 个差异只是 prettier 把函数签名换了行（`Switch`/`Lightbox`）或注释归属边界（`VENDOR_PRESETS`/`SourcesPanel`）；
  产物 `GrowthPage-*.js` 180,293 字节（拆分前 180.28 kB）不变。
- **踩到的两个坑（都已按 lint 要求修正）**：① 组件的 `.tsx` 里不能和组件一起导出常量/纯函数
  （`react-refresh/only-export-components`）→ 才单独拆出 `meta.ts`；② 相对路径深度：`components/growth/` 比 `pages/` 深一层，
  指向 `src/shared` 要 `../../../../shared`。

### 7. T3：`eslint-disable` 里的 `set-state-in-effect` 收敛（试点 → 铺开）

- 现状盘点（渲染端）：`eslint-disable` **55 处**，其中 **47 处**是 `react-hooks/set-state-in-effect` ——
  它们全是同一个形状：`useEffect(() => { void load() }, [load])`，`setState` 明明在 `await` 之后，
  规则看不穿 Promise，于是每个调用点各写一行 disable 注释。
- 新增 `src/renderer/src/lib/useAsyncEffect.ts`：`useAsyncEffect(run, deps)` 把这类调用收成一个 hook
  （**实测规则不再在调用点报警**，而真正的同步 `setState` 仍会被抓到）。
- 铺开范围：**18 个调用点**改为 `useAsyncEffect(fn, deps)`（脚本按「effect 体只有 `void xxx()`」的形状精确匹配，
  多语句/含清理函数的 effect 一律不动）。
- 结果：`set-state-in-effect` **47 → 29**，渲染端 `eslint-disable` 总数 **55 → 39**；
  剩下 29 处是「effect 里多语句 + 直接 setState / 订阅」这类真需要豁免的地方，保留逐条理由注释。

### 8. A2：图表配色收敛到一处

- 新增 `src/renderer/src/lib/theme.ts`：`CHART` 常量集中 ECharts 色值（品牌绿/危险红/信息蓝/琥珀/轴与分隔线/图例文字/分类色板），
  注释里标出各自对应的 `assets/base.css` token；`base.css` 增补 `--chart-blue`（`dashboard.css` 的渐变改用它）。
- `DashboardPage` 的 4 个 `CHART_*` 常量与 3 个轴/图例样式对象、`monitorCharts.ts` 的 `BRAND`/`PALETTE`/
  两处内联色值全部改为引用 `CHART` —— 色值只在 `theme.ts` + `base.css` 各一份，页面里不再出现 `#07c160` 之类的裸色值。
- `lib/ui.ts` 的 `AVATAR_COLORS` **刻意不动**：那是头像辨识用的取色板（同色不代表品牌语义），文件头已注明理由。

### 仍未做（下一轮候选）

1. 渲染端剩余的 **29 处 `set-state-in-effect`**：都是「effect 内多语句 + 直接 setState / 事件订阅」的形状，
   要再收敛得先给这些 effect 补 `useAsyncEffect` 之外的抽象（例如订阅型 `useSubscription`），风险高于收益，暂缓；
2. 主进程侧 `getRowField(row: Record<string, any>)` 的宽类型（T4，需单独排期收窄）。

