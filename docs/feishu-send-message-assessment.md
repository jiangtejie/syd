# 集成「向飞书用户发送消息」评估

> 状态:**评估稿(2026-09),未改产品代码**。基于代码事实 + 本机实测权限探测 + 官方 CLI 命令契约。

## 0. 结论

| 问题 | 结论 |
| --- | --- |
| 可行吗 | **可行,而且比"读飞书表格"便宜得多** |
| 权限现成吗 | **基本现成**:实测产品已保存的飞书应用已具备发送消息权限(见 §2) |
| 最小可用多久 | **P0 约 1~2 人日**(机器人身份 + 单聊/群发送 + 幂等 + 审计 + 设置页测试) |
| 需要引入 lark-cli 吗 | **不需要**。这一个能力自研 1~2 天,引入 CLI 要 10~16 天(见 `docs/lark-cli-integration-assessment.md`) |
| 先要定什么 | 发给谁(用户/群)、以什么身份(机器人/用户)、什么场景发(告警/AI 主动/人工) |

## 1. 现状盘点(代码事实)

| 项 | 现状 |
| --- | --- |
| 飞书出站能力 | **只有回复**:`services/im/feishuService.ts:867 sendTextReply` → `im.message.reply`(收到消息后回原消息),带 `feishuPlainText` Markdown 降级 + 3000 字分片 |
| 主动发送 | **没有**:无 `im.message.create`、无群发、无 Webhook |
| 微信侧可借鉴的治理 | `send/sendService.ts`:串行队列 + 拟人化延迟 + 每日上限 + 闭环校验 + 熔断 + `send_log` 审计;`ai/sendGate.ts`:`send.agentEnabled`/`send.approve` 双闸门;写工具走 `requestToolApproval` |
| 通知现状 | 只有桌面通知(`main/index.ts:222 notifyNewMessage`,`notify.enabled`),无外部推送通道 |
| 身份映射 | `team_member` 只存微信 username,**没有飞书 open_id** → "发给某人"必须先解决映射 |
| IM 渠道 UI | `ImPage` 仅账号/启停/白名单管理,无发送与测试入口 |

## 2. 实测:权限现状(好消息)

用产品已保存的应用凭证(复用 IM 渠道的 `cli_aa10…5be2`,tenant_access_token)直连探测:

| 探测 | 返回 | 含义 |
| --- | --- | --- |
| `POST /open-apis/im/v1/messages`(无效 receive_id) | 400 **99992351** 参数校验失败 | **已具备发送消息权限**(若缺 scope 会先报 99991672) |
| `GET /open-apis/contact/v3/users/{id}` | 400 99992351(同上) | 联系人读取 scope 也已通过校验 |
| `GET /open-apis/im/v1/chats` | **200 code=0** | 能列出机器人所在群 → 群通知目标可发现 |

结论:IM 发送**不受文档协作者限制**(那是文档权限体系),不需要像读 Base 那样再开通/加协作者。

## 3. 三个必须先定的决策

### 3.1 发给谁

| 目标 | 参数 | 前置条件 |
| --- | --- | --- |
| 单聊某个用户 | `receive_id_type=open_id`,`receive_id=ou_xxx` | 需要 open_id;且该用户**在应用的可用范围内** |
| 群 | `receive_id_type=chat_id`,`receive_id=oc_xxx` | 机器人必须已在群里 |
| 部门/全员 | —— | 开放接口不支持,不做 |

open_id 的获取途径:① 入站消息的 `sender_id`(现有飞书渠道已有);② 通讯录按邮箱/手机号解析(需 `contact:user.base:readonly`,实测 scope 已通过);③ 人工录入/导入。

### 3.2 以什么身份

| 身份 | 优点 | 代价 |
| --- | --- | --- |
| **机器人(推荐)** | 凭证现成、无需用户授权、可审计、与现有渠道一致 | 消息显示为机器人,不代表个人 |
| 用户(user_access_token) | 显示为你本人 | 需 OAuth 授权 + 2h token 续期,产品内实现成本高 |

### 3.3 什么场景发

| 场景 | 说明 | 优先级 |
| --- | --- | --- |
| A. 告警/通知 | 新问题、紧急客诉、日报 → 推给运营/群;**桌面通知的升级版** | P0 |
| B. AI 主动发 | 工作台/营销工作台里让 AI 给飞书用户发(对标微信 `send_message`) | P1 |
| C. 人工动作 | 会话/客户页"发到飞书"按钮 | P1 |

## 4. 实现方案

```
UI/触发规则 ──┐
AI 工具 ──────┼─→ 闸门(sendGate 同款:总开关+逐次审批) ─→ 发送层 ─→ 审计/频控
人工按钮 ─────┘                                        │
                                            身份映射(open_id)
```

| 层 | 落点 | 内容 |
| --- | --- | --- |
| 发送层 | `services/im/feishuService.ts`(新增导出) | `sendToUser(accountId, openId, text)` / `sendToChat(accountId, chatId, text)`;复用 `feishuPlainText` + 分片;新增 `uuid` 幂等键(CLI 里叫 `--idempotency-key`) |
| 治理层 | 新表 `feishu_send_log`(或 `send_log` 加 `channel` 列) | 频控(串行 + 日限额)、失败重试、熔断、审计 |
| 闸门层 | `ai/sendGate.ts` 扩展 | `feishu.send.agentEnabled` / `feishu.send.approve`;AI 工具走 `requestToolApproval` |
| 映射层 | 新表 `feishu_contact` 或 `team_member` 加列 | open_id ↔ 姓名/部门/邮箱/微信 username;支持"邮箱/手机号 → open_id" |
| 工具层 | `cap/registry.ts` + `workbench/tools.ts` + `growthTools.ts` | `feishu_send_message`(写,需审批) |
| UI | 设置 → IM 渠道 / 新增"飞书通知" | 发送测试、接收人/群配置、触发事件开关 |

### 分阶段

| 阶段 | 范围 | 人日 |
| --- | --- | --- |
| **P0** | 机器人身份 + 单聊/群发送 + `uuid` 幂等 + 审计 + 设置页"发测试消息" | **1~2** |
| **P1** | 身份映射(邮箱→open_id、通讯录选择)+ `feishu_send_message` 工具 + 审批闸门 + 触发规则(新问题/紧急) | 2~4 |
| **P2** | 富文本 post/交互卡片、附件/图片上传(`im/v1/images` 取 image_key)、群内 @、用户身份发送、多应用路由 | 3~5 |

## 5. 风险清单

| 风险 | 说明 | 缓解 |
| --- | --- | --- |
| 可用范围 | 机器人只能给"在其可用范围内"的用户发单聊,范围外直接失败 | 开放平台把可用范围设对;发送失败回明确提示 |
| 重复轰炸 | 重试/重放导致同一内容多次推送 | **必须带 `uuid` 幂等键**;串行队列 |
| 骚扰与合规 | 主动推送容易被当成骚扰 | 默认只推"紧急/待跟进";可一键关闭;全量审计 |
| 身份混淆 | 同一人同时有微信 username 与飞书 open_id | 显式映射表,禁止按姓名猜测 |
| 内容格式 | 现有 `feishuPlainText` 是纯文本降级,卡片/按钮要新写构造器 | P2 再做;注意内容体积上限 |
| 媒体消息 | 图片/文件需先上传换 image_key/file_key | P2 |
| 限流 | 飞书 IM 发送有频率限制 | 串行 + 节流(参考微信侧频控思路) |

## 6. 与 lark-cli 路线的关系

- 单看"发送消息",**不值得**为它引入 CLI:自研 1~2 天 vs CLI 集成 10~16 天。
- CLI 的 `im +messages-send` 提供 `--markdown`(自动转 post 并优化样式)、`--idempotency-key`、`--dry-run`、媒体上传,若之后确定要多域写能力,发送能力可顺带获得。
- 建议:P0/P1 自研;等真开"多域写飞书"时再上 CLI,届时把发送切到 CLI 也能平滑替换。

## 7. 需要产品确认的三件事

1. 第一批接收人是谁:指定个人(open_id)/指定群(chat_id)/两者都要?
2. 身份:只做机器人,还是也要"以我本人身份发"?
3. 触发场景:先做告警推送(A),还是先做 AI 主动发(B)?

## 8. 落地情况(2026-09,已实现 P0)

产品确认:接收目标**个人 + 群都要**、身份**仅机器人**、首批场景**告警/通知推送**。已实现:

| 层 | 文件 | 内容 |
| --- | --- | --- |
| 发送层 | `src/main/services/lark/im.ts` | `sendImText`(文本/分片/幂等)、`listBotChats`、`resolveOpenIdByEmail`(支持直接粘贴 `ou_…`) |
| 通知层 | `src/main/services/lark/notify.ts` | 目标/事件/日限额配置、`notifyIssueAlert`、`sendFeishuTestMessage`、事件级节流(60s) |
| 审计 | `src/main/db/schema.ts` + `repos/feishuSendLogRepo.ts` | 新表 `feishu_send_log`(目标/内容/结果/错误/消息 id/时间) |
| 触发 | `src/main/services/feedback/scheduler.ts` | 新问题(`pushNewIssueAlert`)、盯办升级(`issue_escalate`)两处钩子,失败不影响主流程 |
| IPC | `src/main/ipc/feishuNotifyHandlers.ts` + preload | `cs:feishu:notify:*`(get/setEnabled/setEvent/addTarget/removeTarget/test/listChats/resolveUser) |
| UI | `src/renderer/src/components/settings/FeishuNotifySection.tsx` | 设置 → IM 渠道 → 飞书通知:开关、事件、目标管理、测试发送、最近记录 |

实测与已知前置条件:

- 发送权限**已具备**(无效 receive_id 返回参数错误 99992351 而非 99991672);`uuid` 等字段被接受。
- **群目标**:当前机器人**未加入任何群**(`GET /im/v1/chats` 返回 0 条),需要先把机器人拉进目标群再在设置页选择。
- **邮箱 → open_id**:需要应用开通 `contact:user.id:readonly` 并发布版本(实测返回 99991672);未开通时可直接粘贴 `ou_…`。
- 未做(P1/P2):AI 工具 `feishu_send_message`、会话页"发到飞书"、富文本卡片、图片/附件、群内 @、用户身份发送。

## 9. 组织联系人(通讯录)接入(2026-09)

需求:先能"取到组织联系人",再挑接收人。实现与实测:

| 项 | 内容 |
| --- | --- |
| 服务 | `src/main/services/lark/contact.ts`:`getContactScope`(可见范围 + 人员姓名)、`listDepartments`(子部门)、`listDepartmentUsers`(部门直属成员)、`getContactUser`(open_id → 姓名/邮箱) |
| 共享调用层 | `client.ts` 新增 `larkCall`(统一取客户端 + 错误码转人话);`im.ts` 改为复用 |
| 错误码 | `40004` → "通讯录可见范围为空或未包含该部门:开放平台「权限管理 → 数据权限」设可见范围并发布版本" |
| IPC/UI | `cs:feishu:contact:scope/departments/users/openAuth`;设置 → IM 渠道 → 飞书通知 → 加同事 → **读取组织联系人**(部门下拉 + 人员列表 + 一键添加);范围为空时给「打开权限申请页」按钮(仅允许 open.feishu.cn) |

**实测(本机应用 `cli_aa10…5be2`)**:

| 探测 | 结果 | 含义 |
| --- | --- | --- |
| `GET /contact/v3/scopes` | 200,**0 部门 / 1 人** | `contact:scope:readonly` 有;可见范围被收窄到 1 人 |
| `GET /contact/v3/users/{该人}` | 200,但 **name/email 为空** | 有 `contact:user.base:readonly`,但数据权限未放开字段 |
| `GET /contact/v3/departments/0/children` | 403 **40004** | 无部门权限 |
| `POST /contact/v3/users/batch_get_id` | 400 **99991672** | 缺 `contact:user.id:readonly` |

结论:**代码已就绪,但"能看到全组织"取决于开放平台的两步配置**(API 权限 + 数据权限可见范围),后者通常需要企业管理员审批:

1. 权限管理 → 开通 `contact:user.id:readonly`、`contact:department.base:readonly`(`contact:user.base:readonly` 已有);
2. 权限管理 → **数据权限 → 通讯录**:可见范围设为「全部员工」或指定部门;
3. 发布版本;再回设置页点「读取组织联系人」。
   一键链接(UI 内按钮,基于当前 appId):`https://open.feishu.cn/app/<appId>/auth?q=contact:user.id:readonly,contact:department.base:readonly&op_from=openapi&token_type=tenant`

在数据权限放开前,仍可用的两条兜底路径:直接粘贴同事 `ou_…`;或把同事拉进群后用群目标。

## 10. 「仅推送」模式(只出不进,2026-09)

需求:机器人**只推送、不接收**——尤其不接收外部群消息。实现为飞书渠道账号级开关:

| 项 | 内容 |
| --- | --- |
| 配置 | `im_channel_account.config.pushOnly`(`ImAccountConfig`/`ImChannelAccount`/`ImChannelAccountInput` 均已加字段) |
| 运行 | `feishuService.startFeishuAccount`:`pushOnly` 时**不创建 WSClient、不注册 `im.message.receive_v1`**,直接置状态「仅推送模式(不接收消息)」并返回;凭证仍保留供出站推送使用 |
| UI | 设置 → IM 渠道 → 编辑飞书账号 → 「仅推送(不接收消息)」开关;账号列表显示「仅推送」标记与状态文案 |

边界说明:

- 关闭长连接后,飞书不会投递任何事件(既无群聊 @ 也无单聊),因此**不存在"接收但不回复"的中间态**;要恢复接收,关掉开关并保存即可(会重建长连接)。
- 若还想在平台侧彻底关闭:开放平台 → 事件与回调 → 取消订阅 `im.message.receive_v1`(或删除长连接配置)。产品内开关更灵活、可随时回滚。
- 与推送能力的关系:推送走 `services/lark/client.ts`(独立 SDK 客户端 + 应用凭证),**不依赖长连接**,所以「仅推送」模式下告警推送照常工作。
- 如需更细粒度(只收单聊、不收群),可在 `onReceive` 里按 `msg.chat_type` 过滤——当前未做,按需再加。

## 11. AI 主动发送 + 工作台「发到飞书」(2026-09,已实现 P1)

产品确认的三个问题沿用 §8 的结论(接收目标个人+群、仅机器人身份、先做推送)。本节补上当时未做的 P1:

| 层 | 文件 | 内容 |
| --- | --- | --- |
| 发送层(共用) | `src/main/services/lark/notify.ts` | 新增 `sendFeishuTextNow({text,targetName?,source})` 与 `sendFeishuGroupIssues({wxid,chatroom})`;抽出 `dispatchTo` 统一「逐个目标发送 + 审计 + 日限额」,告警推送与主动发送共用 |
| 摘要文案(纯函数) | `src/main/services/lark/issueDigest.ts` | `buildGroupIssuesText({groupName,nowText,issues,limit})`:未闭环统计(口径与监控页 `monitor_summary` 一致)、严重度/类型标签、跟进状态与跟进人、超出上限尾注 |
| AI 工具 | `src/main/services/lark/tools.ts` | `feishu_send_message(text,target?)`,**`confirm: true` → 走审批桥**;接收方只能是设置里已配置的目标,模型无法凭空指定 receive_id |
| 注册表 | `src/main/services/ai/cap/registry.ts` | LARK_CAPS 增 `feishu_send_message`(目录行/触发场景);顺带修 `readOnly` 判定(此前只认 `send_message`,新写类能力会被误标成只读 → 现改为 `!isWriteCap(name)`) |
| IPC/桥 | `feishuNotifyHandlers.ts` + preload + `shared/api.ts` | `cs:feishu:notify:sendGroupIssues(wxid,chatroom,targetName?)`,返回 `{ok,sent,count,targets,error}` |
| UI | `components/workbench/GroupIssuesPanel.tsx` | 群问题面板头部新增「发到飞书」按钮(发送中禁用;未配置目标时把主进程的可行动提示原样 toast) |

安全边界(与告警推送一致):目标白名单(仅设置里配置过的目标)、日限额、幂等键、`feishu_send_log` 审计落库;
写类能力经审批桥人工确认后才执行。自检覆盖:`scripts/lark-sync-selftest.mjs` 第 [14] 节(9 例:口径/done 不进摘要/标签/尾注/上限)。

仍未做(沿用原判断,按需再加):富文本卡片、图片/附件、群内 @、以用户身份发送。
