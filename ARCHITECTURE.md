# 微信私域智能客服（wechat-cs-desktop）技术架构与功能要点

> 本文档梳理项目的整体技术架构、模块划分、核心功能实现要点与数据模型，作为后续开发与维护的参考。

---

## 1. 项目概述

`wechat-cs-desktop` 是一款面向微信私域客服的 **Electron 桌面客户端**，核心目标：把个人微信的数据（会话、消息、图片附件）读入本地工作台，并辅助真人客服 **生成回复建议、一键发送**，同时提供客户分层、数据看板、审计等运营能力。

产品名称（应用内）：**微信私域智能客服**。

关键技术特征：

- 读取并解密本地微信数据库（微信 4.x「魔改 SQLCipher」格式）。
- 通过 PowerShell + Win32 API 模拟键盘/剪贴板，向真实微信客户端「注入」发送消息。
- AI 话术建议由 LLM 生成（OpenAI 兼容），AI 未启用/未配置时不产出任何候选（内置示例模板与兜底话术已移除，避免模拟话术误导），由 UI 提示引导配置。

---

## 2. 技术栈

| 层 | 技术 | 说明 |
| --- | --- | --- |
| 桌面框架 | Electron 39 + electron-vite 5 | 主进程 / preload / 渲染进程三端构建 |
| 前端 | React 19 + TypeScript 5 | 渲染层 UI |
| 状态管理 | zustand 5 | 工作台全局状态 |
| 本地数据库 | better-sqlite3-multiple-ciphers | 本地业务库 + 打开微信加密库（兼容 SQLCipher/明文） |
| 消息解压 | fzstd | 微信消息正文 zstd 解压 |
| 图片解密/转码 | node:crypto + 外部 ffmpeg | .dat 解密、wxgf（HEVC）转 JPEG |
| 打包 | electron-builder 26 | 产物、图标、安装包 |
| 代码规范 | ESLint 9 + Prettier 3 | 统一风格 |

---

## 3. 目录结构

```
wechat-cs-desktop/
├── src/
│   ├── main/                     # 主进程
│   │   ├── index.ts              # 入口：窗口、托盘、菜单、单实例锁、media 协议
│   │   ├── db/                   # 本地业务库（cs.db）
│   │   │   ├── database.ts       # 单例 + WAL
│   │   │   ├── schema.ts         # 建表 / 迁移
│   │   │   └── repos/            # 数据访问层（config / keyStore / sendLog）
│   │   ├── ipc/                  # IPC handler 注册（按域拆分）
│   │   └── services/
│   │       ├── wechat/           # 微信读库核心（解密/定位/查询/监控/注入）
│   │       ├── ai/               # AI 建议生成
│   │       ├── send/             # 发送执行层（队列/频控/熔断/审计）
│   │       ├── media/            # 图片 .dat 解密
│   │       ├── keyStoreService.ts# 密钥管理
│   │       └── paths.ts          # 缓存目录策略
│   ├── preload/
│   │   ├── index.ts              # contextBridge 暴露 window.api
│   │   └── index.d.ts            # 类型声明
│   ├── renderer/
│   │   └── src/
│   │       ├── App.tsx           # 应用外壳（标题栏 + 左侧导航 + 页面区）
│   │       ├── pages/            # 对话/客户/看板/设置 四大页面
│   │       ├── components/       # 标题栏、工作台子组件、设置组件
│   │       ├── stores/           # zustand（workbench / toast）
│   │       └── lib/              # 客户派生算法、UI 工具
│   └── shared/
│       └── types.ts              # 三端共享类型（IPC 契约）
├── resources/
│   ├── ps/wechat-inject.ps1      # Windows 注入脚本（Win32 API）
│   └── icon.png
├── scripts/                      # 开发期 spike/probe 脚本
├── build/                        # 图标 / 打包资源
└── electron.vite.config.ts
```

---

## 4. 进程架构

```
┌─────────────────────────────────────────────────────────┐
│                    主进程 (main)                         │
│  - 窗口/托盘/菜单/单实例锁                               │
│  - 本地库 cs.db（better-sqlite3）                       │
│  - 微信库解密/读库/监控                                  │
│  - 发送队列 + 注入引擎（PowerShell）                     │
│  - AI 建议生成、媒体解密                                  │
│  - ct-media:// 自定义协议                                │
└───────────────▲──────────────────────┬──────────────────┘
                │ ipcRenderer.invoke   │ webContents.send
┌───────────────┴──────────────────────▼──────────────────┐
│                 preload (contextBridge)                  │
│  暴露 window.api.cs.{wx,keyStore,ai,reply,config,dialog,  │
│  media,app}；window.electron（electron-toolkit）          │
└───────────────▲─────────────────────────────────────────┘
                │
┌───────────────┴─────────────────────────────────────────┐
│                  渲染进程 (React 19)                     │
│  对话工作台 / 客户 / 看板 / 设置，zustand 状态管理        │
└─────────────────────────────────────────────────────────┘
```

- **安全隔离**：`contextIsolation` 开启（`sandbox: false` 供 preload 使用 Node API），渲染层只能通过 `window.api` 调用受控 IPC，不直接接触明文密钥。
- **共享契约**：`src/shared/types.ts` 定义跨进程类型，preload 用 `invoke` 双向传递结构化数据。

---

## 5. 核心功能模块

### 5.1 微信库解密与定位（T4）

微信 4.x 数据库为腾讯魔改 SQLCipher 格式，实现位于 `services/wechat/decrypt.ts`：

- **页结构**：页大小 4096，reserve=80（IV 16B + HMAC-SHA512 64B）。
  - 页 1：前 16B 为 salt；加密区为 `file[16:4016]`，解密后补写标准头 `SQLite format 3\0`。
  - 页 N：加密区为 `page[0:4016]`，IV 在 `page[4016:4032]`。
- **密钥派生**：`AES key = PBKDF2-HMAC-SHA512(encKey, salt, iter=256000, dklen=32)`，逐页 AES-256-CBC 解密（无 padding）。
- **WAL 合并**：解析 WAL 帧（32B 头 + N×(24B 帧头 + 4096B 帧页)），将「文件头第一周期帧」解密合并到主库，覆盖新页并修正 db size 字段，失败时静默回退主库。
- **明文缓存**：解密结果落盘到缓存目录 **db 分区**（`db/<name>_<hash>.db`，历史目录 `wx-plain` 已并入，启动自动迁移），以「源库路径 + key」的 md5 命名复用；每次打开只读、用完即关。

> 缓存目录规范结构（由 `services/paths.ts` 统一管理，写缓存代码禁止硬编码子目录）：
> `db/` 解密微信明文库副本 · `media/<wxid>/` 附件解码产物（图片/视频，ct-media 协议映射根）· `tmp/` 一次性临时文件 · `export/` 用户导出产物；「清理缓存」会整目录清除。

数据库定位 `dbLocator.ts` 兼容多种目录形态：

- `<root>/db_storage`
- `<root>/<wxid>/db_storage`
- `<root>/<wxid>_xxxx/db_storage`

并递归扫描 `msg_*.db / message_*.db` 消息库、加权定位 `session.db`、`contact.db`、`head_image.db`。

### 5.2 密钥管理（§4.9）

`keyStoreService.ts`：取 key 与用 key 解耦，客户端只「安全持有 + 解密」。

- 密钥来源：`registry`（注册表，待探测）/ `import`（导入）/ `manual`（手动）。
- 导入校验：64 位十六进制（32 字节）。
- 落库：用 Electron `safeStorage.encryptString` 加密后存 `key_store`，**明文 key 仅在主进程内存中解密持有，不落盘**。
- 状态机：`pending → valid / invalid`，`testKey` 通过「试开真实库」验证并回写状态与错误原因。

### 5.3 消息读取（queries.ts）

- 会话列表：读 `session.db`（`SessionTable / Session / session` 兼容），按 `sort_timestamp` 倒序，过滤系统号/服务号（`weixin`、`qqmail`、`fmessage` 等）。
- 联系人 enrich：读 `contact.db`，补备注/昵称/别名/头像/置顶（flag `0x800`）/折叠（flag `0x10000000`）。
- 消息读取：会话 id 经 `md5` 得到消息表名 `msg_<hash>`，跨多个消息库合并、去重、时间倒序分页。
- 发送人判定：微信 4.x Msg 表无 `is_send` 列，用 `real_sender_id` 对照 `Name2Id` 表中的「我的 rowid」判断是否己方发出。
- 内容解析：`content.ts` 处理 zstd 解压（magic `0xFD2FB528`）、XML/HTML 实体、按 `localType` 映射摘要（文本/图片/语音/名片/视频/表情/位置/链接文件/系统消息），并提取图片 md5、语音时长、文件名大小。
- 头像解析：`contact` 表 URL（big/small）优先，`head_image.db` 的 `image_buffer` BLOB 兜底转 base64。
- 列名兼容：`schema.ts` 通过 `PRAGMA table_info` 探测多种列名候选（`message_content/display_content/content` 等），适配不同微信版本。

### 5.4 库变更监控（T5）

`monitor.ts` + `watchService.ts`：

- 双通道：`fs.watch` 监听库目录 + 2s 轮询对比 mtime/size 兜底。
- 变化经 500ms debounce 后广播 `cs:wx:dbChanged` 给渲染层，并触发主进程新消息提醒。
- 生命周期按 wxid 管理（`startWatch/stopWatch/stopAllWatches`），幂等。

### 5.5 AI 建议生成（T7）

`suggest.ts`：输入「会话上下文（最近消息）+ 智能体人设」→ 输出 1~3 条候选（ai_free）。流程：

- **LLM 生成**：`provider.ts` 抽象任意 OpenAI 兼容接口（`/chat/completions`），配置 `ai.baseUrl/ai.apiKey/ai.model/ai.enabled`，按智能体（`ai_agent`）组装系统提示词（名称+人设+风格+自定义守则），输出 JSON 数组解析为候选。
- **空结果与错误**：AI 未启用/未配置 Key/生成失败时不返回任何内置话术，仅回传错误提示由 UI 展示（设置页可开启通道并测试）。

> 内置示例模板（kb_direct 关键词底稿：价格/试用/寒暄等虚构文案）与兜底话术已随「去除模拟数据」移除；真实知识库命中待 `knowledge_item` 接入后另行实现。

### 5.6 发送执行（T8）

`sendService.ts` + `injector.ts`：

- **全局串行队列**：注入是独占资源，多任务排队逐个执行。
- **注入引擎**：`injector.ts` 调 PowerShell（`resources/ps/wechat-inject.ps1`），Win32 API 找窗口 → 抢前台 → `Ctrl+F` 搜索会话 → 剪贴板粘贴正文 → Enter 发送。
- **拟人化延迟**：发送前随机 0.9~2.6s，会话间随机 2.5~7s（可关闭）。
- **频控**：每日上限（默认 200）。
- **闭环校验**：发完回查微信库确认己方消息存在；连续 2 次校验失败自动 **熔断**（`send.halted`）。
- **审计**：所有发送（自动/人工）写 `send_log`，含 mode/source/result/verified。

### 5.7 图片媒体解密（M3）

`media/mediaService.ts` + `media/datDecrypt.ts`：

- 定位 `msg/attach` 下 `<md5>.dat / _t.dat / _h.dat`。
- 解密 `.dat`：V1/V2（15B 头，AES-128-ECB + XOR）、V3（整文件 XOR），密钥从 `img:{wxid}:xorKey / aesKey` 配置读取。
- 解密后处理 wxgf（微信 HEVC 容器）：优先内嵌 JPEG/PNG 截取；纯 HEVC 时切 NAL 流交外部 ffmpeg 转 JPEG 首帧。
- 结果写缓存目录 `media/<wxid>/<md5>_<kind><ext>`，通过自定义 `ct-media://` 协议暴露给渲染层（`index.ts` 的 `registerMediaProtocol`，含路径/文件名强校验）。

---

## 6. IPC 接口一览

preload 暴露 `window.api.cs.*`，主进程 `ipc/` 按域注册：

| 域 | 通道 | 说明 |
| --- | --- | --- |
| keyStore | `cs:key:getStatus/list/import/test/refresh` | 密钥状态/导入/验证 |
| wx | `cs:wx:connect/getSessions/getMessages/getMessagesSince/getAvatar/startWatch/stopWatch` | 微信读库与监控 |
| ai | `cs:ai:generateReply` | 生成回复候选 |
| reply | `cs:reply:sendText/getSendStatus/stats7d/resetCircuit/stopAll` | 发送与状态 |
| config | `cs:config:getAll/set/cachePath` | 全局配置 KV |
| dialog | `cs:dialog:pickDirectory` | 目录选择 |
| media | `cs:media:decryptImage/testImageDecrypt` | 图片解密 |
| app | `cs:app:info/getAutoLaunch/setAutoLaunch/dataStats/clearCache` | 应用级能力 |

推送事件：`cs:wx:dbChanged`（库变化）、`app:navigate`（菜单/托盘触发导航）。

---

## 7. 本地数据模型（cs.db）

本地业务库只存「密钥、配置、决策、审计」，消息本体存于微信 DB。表结构见 `db/schema.ts`：

| 表 | 用途 |
| --- | --- |
| `key_store` | 微信库密钥（加密存储）+ 来源 + 状态 |
| `app_config` | 全局 KV 配置（门控/频控/AI/注入/缓存路径） |
| `customer` | 客户档案（预留，当前客户页由会话派生） |
| `session` | 会话状态（支撑门控与转人工，预留） |
| `tier_rule` | 条件规则 P1~P4（预留，P5~P8 为引擎内建） |
| `knowledge_item` | 知识库条目（预留） |
| `reply_decision` | 回复候选与决策状态机（预留） |
| `send_log` | 发送审计日志（已使用） |

当前实际落地使用：`key_store`、`app_config`、`send_log`；其余表为方案设计预留（客户库/知识库/规则引擎接入后使用）。

---

## 8. 配置键（app_config）

| 键 | 默认 | 说明 |
| --- | --- | --- |
| `ai.enabled` | `0` | 启用 LLM 生成 |
| `ai.baseUrl` | `https://api.openai.com/v1` | OpenAI 兼容接口 |
| `ai.apiKey` | 空 | API Key（落库前 safeStorage 加封，`enc1:` 前缀；明文形态兼容，启动时迁移存量） |
| `ai.model` | 空 | 模型名（不预置；由「获取模型」拉取或手动填写，未填时通道视为未配置） |
| `send.dailyLimit` | `200` | 每日发送上限 |
| `send.humanizeDelay` | `1` | 拟人化延迟开关 |
| `send.halted` | `0` | 熔断状态 |
| `inject.enabled` | `1` | 注入发送总开关 |
| `notify.enabled` | `1` | 新消息系统通知 |
| `cache.path` | 空（自动） | 缓存目录 |
| `img:{wxid}:xorKey` / `aesKey` | 空 | 图片解密密钥 |
| `key:{wxid}:error` | 空 | 密钥错误原因 |
| `media.ffmpegPath` | 空 | 外部 ffmpeg 路径 |

---

## 9. 桌面体验设计

- **单实例锁**：二次启动聚焦已有窗口。
- **自定义标题栏**：`titleBarStyle: hidden` + `titleBarOverlay`，渲染端自绘 36px 拖拽区，保留原生窗控。
- **关闭最小化到托盘**：客服工作台常驻后台，托盘菜单「退出」才真正退出。
- **新消息提醒**：窗口未聚焦时 `flashFrame` + 系统通知（节流 5s），点击通知聚焦。
- **防白闪**：窗口背景色与渲染端一致；`ready-to-show` 后再显示。
- **媒体协议**：`ct-media://` 解决 dev（http）/生产（file）渲染源下子资源加载一致性问题。

---

## 10. 待完善 / 预留项

- `customer`、`session`、`tier_rule`、`knowledge_item`、`reply_decision` 表已建，但对应功能（客户库、知识库、条件规则引擎、门控 G1/G3/G4、转人工）尚未接入，客户页/看板部分数据为示例算法。
- 密钥 `registry` 直读（M3 探测）尚未实现，当前 `refreshKey` 仅返回现有状态，需走手动导入。
- 看板「近 7 日消息量」为示例数据，解密层接入后可替换为真实统计。
- 图片 HEVC 原图依赖外部 ffmpeg，需在设置中配置路径。

---

## 11. 开发与构建

```bash
npm install        # 安装依赖
npm run dev        # 开发模式（electron-vite dev + HMR）
npm run typecheck  # node + web 两侧类型检查
npm run lint       # ESLint
npm run build:win  # 打包 Windows（mac/linux 同理）
```

关键脚本：`npm run typecheck`（`typecheck:node` + `typecheck:web`）、`npm run build`（typecheck + electron-vite build）、`electron-builder --win` 出安装包。
