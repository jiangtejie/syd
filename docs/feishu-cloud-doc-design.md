# 飞书云文档读取能力(只读)设计

> 状态:**已落地(2026-09)**。目标:让产品内的 AI(客服工作台 / 对话页 / IM 通道 / 营销 AI 工作台)
> 能直接读飞书多维表格(Base)与云文档,而不是让用户手工导出 CSV。
>
> **失效项(2026-09 追加)**:入口之一「营销 AI 工作台」已随营销模块**整体下线**;能力本体
> (飞书云文档 / Base 只读)不受影响,仍在用。

## 1. 背景:为什么"加个飞书技能"不work

实测(2026-09-09,营销 AI 工作台)用户发来
`https://xxx.feishu.cn/base/<app_token>?table=<table_id>&view=<view_id>` 要求读取,模型回答:

> 当前可用能力里没有"读取飞书多维表格/表格文档"的工具…… 没有任何工具能读取飞书 base/多维表格。

根因是两层,和"技能没装对"无关:

| 层 | 现状 | 结论 |
| --- | --- | --- |
| 技能(SKILL.md) | `services/ai/workbench/skills.ts`:目录扫描 + frontmatter 校验 + 正文注入(≤2400 字/技能),**无代码执行** | 只能改变口径,不能新增能力;写一个 `lark-base` 技能也不会让模型能读表 |
| 工具(ToolDef) | 工具集是**硬编码白名单**(微信业务 / 工作区文件 / 软件状态;营销侧 `growthTools.ts`) | 没有任何飞书/通用 HTTP 工具 → 模型只能如实说"做不到" |

所以扩展点只有一个:**新增可执行工具**,复用已有飞书自建应用凭证。

## 2. 架构(唯一实现 + 三处注册)

```
tools.ts(LARK_TOOLS,只读 3 个工具)      ← 能力声明(ToolDef)
        │
api.ts(读数据 + 渲染 + 错误转人话)       ← 唯一实现(工具层与设置页测试共用)
        │
client.ts(凭证解析 + SDK 客户端缓存 + 错误码提示)
        │
url.ts(/base/ /docx/ /wiki/ /sheets/ 链接解析)
```

| 文件 | 作用 |
| --- | --- |
| `src/main/services/lark/url.ts` | 链接/token 解析(kind、app_token、table、view);裸 token 按 Base 处理 |
| `src/main/services/lark/client.ts` | 凭证优先级:设置页 `lark.appId`/`lark.appSecret` → IM 渠道 `im_channel_account`(channel=feishu);SDK Client 缓存;错误码 → 可行动提示 |
| `src/main/services/lark/api.ts` | `listTables / listFields / listRecords / docxText / resolveWikiNode`;`readBaseResult`(带 ok)/`readBaseAsText`(工具入口)/`readDocAsText`/`testLarkAccess` |
| `src/main/services/lark/tools.ts` | `lark_base_tables` / `lark_base_records` / `lark_doc_read`(`needsWx:false`、只读、不审批) |
| `src/main/services/ai/cap/registry.ts` | 新能力组 `cloud`(tier 2,按需挂载):客服工作台 / 对话页 / IM 通道经 `list_capabilities`→`mount_capability` 使用 |
| `src/main/services/ai/workbench/tools.ts` | 工作台常驻工具组 `cloud` |
| `src/main/services/growth/ai/growthTools.ts` | 营销工作台 `growth_read_lark_base`(只读,无审批) |
| `src/main/ipc/larkHandlers.ts` + preload + `SettingsPage` | 设置 → AI 助手 → 飞书云文档:凭证、默认链接、`测试读取`(`cs:lark:status`/`cs:lark:test`) |

凭证落库走既有 `cs:config:set`,`lark.appSecret` 已加入 `configHandlers.ts` 的 `SECRET_KEYS`(safeStorage `enc1:` 加封)。

## 3. 权限前提(不做这步,代码通了也读不到)

1. 开放平台 → 权限管理,为应用开通并**发布版本**:
   - 多维表格:`bitable:app:readonly`(或 `bitable:app` / `base:table:read`、`base:record:retrieve`)
   - 云文档:`docx:document:readonly`
2. 把应用加为目标文档的协作者:打开该 Base/文档 → 分享 → 添加协作者 → 搜索应用名 → 「可阅读」。
3. 常见错误码(工具会把它翻成可行动提示):

| code | 含义 | 处理 |
| --- | --- | --- |
| 99991672 | 应用缺少接口权限(scope) | 按接口返回 msg 里的一键授权链接开通,并发布版本 |
| 99991663 | 应用未被授权访问该文档 | 分享 → 添加协作者,把应用加为可阅读 |
| 1254005 / 1254300 / 1254302 | 多维表格权限不足 | 同上 + 确认 bitable 权限已开通 |
| 99991661 | 凭证无效/应用停用 | 检查 App ID/Secret 与应用版本 |

**实测结论(本机,2026-09-09)**:IM 渠道里已保存的自建应用 `cli_aa10…5be2` 凭证有效
(可拿到 `tenant_access_token`),但调用该 Base 返回 `99991672`(缺 `bitable:app:readonly`),
即"凭证 OK、scope 待开通";开通并发布后再用设置页「测试读取」复核。

## 4. 只读边界与上下文预算

- 全部只读:不新增/修改飞书数据,因此不进入审批闸门(与软件能力同档);
- 输出裁剪:行 ≤200、列 ≤12、单元格 ≤80 字;分页用 `page_token` 游标,超限给提示;
- 与既有引擎预算一致:工作台工具输出上屏 ≤4000 字符、行级证据 ≤200 行;营销引擎工具输出同样截断。

## 5. 未覆盖(下一步候选)

- 电子表格(`/sheets/`)未支持:当前提示"导出 CSV/Excel 放工作区";
- ~~写回(Base 新增/更新记录)未做~~ → **已落地(2026-09,见 §6)**;~~视图筛选(`filter`/`sort`)未暴露;附件下载未做~~ → **已落地**;
- 通用化:接入 MCP 客户端后,第三方飞书技能可即插即用(`kind:'mcp'` 骨架仍在注释里)。

## 6. 写回 + 筛选排序 + 附件下载(2026-09,已实现)

| 能力 | 实现 | 审批 |
| --- | --- | --- |
| Base 写回 | `api.ts`: `resolveBaseForWrite`(链接/知识库 → app_token+table_id)、`createBaseRecord`、`updateBaseRecord`、`writeBaseRecordAsText`(无 record_id = 新增,有 = 更新);工具 `feishu_base_write` | **`confirm: true`** → 走审批桥(飞书会话里是按钮卡片,见命令自动化文档 §3.8) |
| 写入字段校验(纯函数) | `lark/recordFields.ts`: `parseRecordFields(json)` —— 必须是 JSON 对象、键去空白、值原样(数字/布尔/null 不改写)、空对象/数组/标量/非法 JSON 都给人话报错、单次 ≤40 列 | 自检 `scripts/lark-sync-selftest.mjs` 第 [16] 节 12 例 |
| 视图筛选/排序 | `listRecords` 增 `filter`(飞书公式)/`sort`(JSON) 透传;`lark_base_records` 工具暴露这两个参数;返回文本里注明「已按条件筛选/已排序」 | 只读,不审批 |
| 附件下载 | `client.ts`: `larkDownloadMedia(file_token)` —— 二进制接口**不套 larkCall**(与 uploadAll 同一类坑),用 tenant_access_token + fetch 直取;工具 `feishu_file_download` 落盘到 `<userData>/lark-files/`(文件名走共享 `safeFileName`) | 只读(不改飞书数据) |

⚠ 待实测:附件下载走的是 REST 二进制接口,代码按官方文档实现,但**本机未实测**(需要真实附件 file_token)。
若报 `http 403/404`,优先检查:应用是否开通 `drive:drive:readonly`、以及该附件是否属于本应用可访问的 Base。

仍未做:电子表格(`/sheets/`)直读 —— 仍提示「导出 CSV/Excel 放工作区」;MCP 客户端接入。
