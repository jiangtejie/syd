# 把 lark-cli 集成进产品:可行性与成本评估

> 状态:**评估稿(2026-09),未改产品代码**。评估对象:官方开源 CLI `@larksuite/cli`(飞书 CLI)。
> 事实来源:本机实测(v1.0.69)+ 官方 README/--help + 官方文档《飞书 CLI 能力介绍与最佳实践》。

## 0. 结论

| 问题 | 结论 |
| --- | --- |
| 技术上可行吗 | **可行**。原生二进制、明确 JSON 契约、非阻塞设备码授权、`--dry-run`/风险分级,都是为"被 Agent 驱动"设计的 |
| 官方支持产品化集成吗 | **支持**。README 与官方文档都写明面向"构建企业级 AI Agent 的团队,可直接集成进你的 Agent" |
| 现在该整体替换刚做的自研只读工具吗 | **不建议**。建议分层混合:自研只读工具继续服务"读几张表"的高频场景,CLI 作为写操作/长尾域的扩展通道 |
| 若要"像官方 Agent 一样全面操作飞书"呢 | 那 CLI 是唯一现实路径(自研 SDK 覆盖等于重写官方 CLI) |

## 1. 事实清单(本机实测 + 官方文档)

| 维度 | 事实 |
| --- | --- |
| 版本/许可 | `@larksuite/cli` 1.0.69,MIT,仓库 github.com/larksuite/cli |
| 安装 | `npx @larksuite/cli@latest install`;npm 包只含脚本,postinstall 下载平台原生二进制 |
| 体积 | 安装目录 **82.5 MB**;原生二进制 `bin/lark-cli.exe` **41.7 MB**(另有 40.5 MB 的 `lark-cli`) |
| 运行时 | 原生二进制(Go)自身不需要 Node;npm 启动器 `scripts/run.js` 需要 node —— 产品内可直接 spawn `bin/lark-cli.exe` 绕过 |
| 启动延迟 | 本机实测 `--version` 100~190 ms,`skills list` 111 ms(单次调用成本可接受) |
| 输出契约 | `--format json\|markdown\|table\|ndjson\|csv`;成功 `{ok:true,data,meta}` → stdout/exit 0;失败 `{ok:false,error:{type,subtype,code,message,hint}}` → stderr/非 0;`--jq` 过滤;`--page-all/--page-limit/--page-delay` 翻页 |
| 鉴权 | OAuth 设备码登录;`auth login --recommend / --domain / --scope`;**Agent 模式 `--no-wait` 立即返回验证 URL,再用 `--device-code <code>` 续 poll**;`auth check <scope>` 退出码 0/1;`auth status/scopes/list` |
| 凭证存储 | `~/.lark-cli/config.json` 只存 appId + **keychain 引用**(`{"source":"keychain","id":"appsecret:cli_…"}`),密钥落 OS 钥匙串;本机已配置另一个应用 `cli_aacf01bc16785bc9`(与产品 IM 渠道的 `cli_aa10…5be2` 不同) |
| 身份 | 每条命令 `--as user\|bot`;`config bind --identity bot-only\|user-default`;`config strict-mode` 收紧策略 |
| 风险分级 | 每个命令标注 `read\|write\|high-risk-write`;`high-risk-write` 必须 `--yes`;写操作可先 `--dry-run` 预演 |
| 能力面 | 21 个业务域(im/calendar/docs/drive/sheets/base/wiki/mail/task/okr/vc/slides/whiteboard/markdown/minutes/note/event/contact/approval/apps/attendance)+`api` 原始逃生口+`schema` 内省+`skills`(内嵌 24 个 skill) |
| Base 读能力 | `base +record-list --base-token … --table-id … [--field-id 投影] [--view-id] [--filter-json] [--sort-json] [--limit 1-200] [--format markdown|json]` —— **自研 `lark_base_records` 是它的子集** |
| 环境门禁 | 检测 `OPENCLAW_HOME`/`HERMES_HOME`/`LARK_CHANNEL`,未 `config bind` 时拒绝执行(本机因 `HERMES_HOME` 命中而报错);打包应用进程内通常无此变量 |
| 已知体验痛点 | 官方文档 157 条评论里最高频的是:授权频繁/2h token 过期、bot 身份建的文档自己看不到、user token 失效后自动切应用身份、skill 包太大占 context、企业应用发布要管理员审核 |

## 2. 三条路线对比

| | A. 纯自研 SDK 工具(现状) | B. 纯 CLI 通道 | C. 混合(推荐) |
| --- | --- | --- | --- |
| 实现 | 直接调 OpenAPI(已落地) | 产品内 spawn CLI,按域暴露工具 | 自研读工具 + CLI 扩展通道 |
| 能力覆盖 | 只读、只覆盖我们写的那几个接口 | 21 个域、100+ 命令、读写全 | 高频读走自研,长尾/写走 CLI |
| 体积 | 0(复用已有 SDK 依赖) | +42~83 MB/平台 | +42~83 MB/平台 |
| 授权 | 复用 IM 渠道应用凭证(应用身份) | 需设备码用户授权 + 应用配置 | 两者并存 |
| 权限模型 | 应用必须被加为文档协作者(我们踩的 99991663) | 可用 user 身份,天然是你自己的权限 | 用户身份解长尾 |
| 安全面 | 小(只读) | 大(可写、可发消息,以用户身份) | 中:写路径全部走审批 |
| 维护成本 | 自己跟 OpenAPI 变更 | 跟官方 CLI 版本(迭代很快) | 中 |
| 升级路径 | 每加一个能力要写代码 | 官方加域即得 | 渐进替换 |

## 3. 推荐形态(方案 C 的落地轮廓)

1. **进程层**:内置指定版本的 `lark-cli` 二进制(按平台裁剪),主进程用 `spawn` 调用;统一超时/取消/编码(Windows 注意 GBK→UTF-8);**禁用自更新**(`lark-cli update` 与检查更新),版本随产品走。
2. **授权层**:设置页发起 `auth login --recommend --no-wait` → 拿验证 URL/二维码给用户 → 后台用 `--device-code` 续 poll → `auth status` 展示域与 scope;token 过期前提醒续期。
3. **工具层**:不让模型拼 shell。代码构造命令,只暴露白名单参数:
   - 只读工具(默认):`base +record-list/+record-search/+data-query`、`docs +fetch`、`wiki`、`sheets +read` 等;
   - 写工具:按 CLI 的 risk 标签映射到现有 `requestToolApproval`(`write` 逐次确认,`high-risk-write` 强制确认 + 二次确认);
   - 每个工具固定 `--as`(默认 user,可切换 bot),并把 `--dry-run` 作为"预览"能力。
4. **上下文层**:24 个 skill 的正文**不常驻**,按需 `lark-cli skills read <domain>` 取一份注入(与现有能力注册表的"目录 + 按需挂载"一致);工具描述保持一句话。
5. **安全层**:域白名单(默认只开 base/docs/sheets/wiki 的读)、写操作审批、审计落库、禁止 `api` 原始逃生口直接暴露给模型(或仅限白名单路径)。

## 4. 成本估算(不含产品打磨)

| 工作项 | 说明 | 人日 |
| --- | --- | --- |
| 二进制分发/打包 | 按平台裁剪、Electron 打包体积、首次运行不下载 | 1~2 |
| 进程封装 | spawn/超时/取消/流式读取/JSON 契约解析/错误分类 | 1~2 |
| 授权生命周期 | 设备码 URL+二维码、`--no-wait`+`--device-code`、续期提醒、多应用/多用户 profile | 2~3 |
| 工具封装与审批映射 | 白名单参数、read/write/high-risk → 审批闸门、dry-run | 1~2 |
| 设置页 | 状态/授权/域开关/测试连接 | 1~2 |
| 上下文预算 | 按需注入 skill 正文 | 1 |
| 打包/离线/更新策略 | 禁自更新、版本锁定、镜像源兜底 | 1 |
| 回归与安全测试 | 提示注入、越权、并发、Windows 路径与编码 | 2~3 |
| **合计** | | **10~16 人日** |

## 5. 风险清单

| 风险 | 影响 | 缓解 |
| --- | --- | --- |
| 安全面扩大(以用户身份写飞书/发消息) | 高 | 默认只读 + 域白名单 + 写操作逐次审批 + 审计 |
| 安装包体积 +42~83 MB | 中 | 按平台只带一份;或首次运行按需下载(牺牲离线) |
| 自更新改写内置二进制 | 中 | 禁 `update`,固定版本;打包时校验 checksums.txt |
| 版本漂移(CLI 迭代极快) | 中 | 锁版本 + 契约测试(用 `--dry-run`/JSON 信封断言) |
| 授权体验(token 过期、频繁授权) | 中 | 过期前提醒 + 静默续期 + 一次授权覆盖常用域 |
| 企业应用需管理员审核 | 中 | 引导最小权限申请;必要时提供"自带应用"入口 |
| 离线/受限网络安装 | 中 | 内置二进制,不走 postinstall 下载;镜像源兜底 |
| 许可与再分发 | 低 | MIT,保留 LICENSE/NOTICE |

## 6. 建议节奏

- **阶段 0(现在)**:开通 `bitable:app:readonly` + 发布版本,验证已落地的自研只读工具能读通这张表(1 条一键链接,见 `docs/feishu-cloud-doc-design.md`)。
- **阶段 1(1~2 周)**:方案 C 的读部分 —— 内置 CLI,只开 base/docs/sheets/wiki 的读,设备码授权,一个 `lark_cli` 只读工具。
- **阶段 2**:按需开写域(im/docs/base 写),全部走审批;补域开关与审计。
- **阶段 3**:评估是否用 CLI 替换自研读工具(能力已是超集),或保留双通道。

## 7. 什么时候不该用 CLI

- 只想读几张表、要求离线优先、安装包要小、不想引入子进程 → 保持自研只读工具;
- 强合规场景不允许产品内 AI 以用户身份操作飞书 → 只用应用身份只读;
- 目标平台没有官方二进制(边缘架构)→ 自研。
