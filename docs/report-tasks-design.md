# 定时任务 · 数据上报模块(ReportJobs)

设置 → 「定时任务」tab 的数据上报任务管理器。v1 提供 `chat_sync` 任务:把本地微信账号的
聊天记录**增量**上报到外部 PostgreSQL,表结构与旧独立脚本 chat-sync(chat.sessions /
chat.messages)完全兼容,外部 agent 原有 SQL 可原样继续使用。

## 用法

1. 重启应用(首次启动自动建本地表 `report_job / report_cursor / report_run`);
2. 设置 → 定时任务 → 「＋ 新建上报任务」:
   - 来源账号:已导入密钥的微信账号(单任务单账号;同账号同类型任务唯一);
   - 范围:全部/仅群聊/仅单聊/白名单;首轮回溯天数(0=全量);单轮上限(0=不限);
   - 目标库:PostgreSQL host/port/db/user/schema(默认 `chat`)+ 口令(系统加密,列表不回显);
   - 调度:按间隔(≥30s)/每日 HH:mm/仅手动;「保存后启用」;
3. 保存前可「测试连接」;保存后点「立即执行」跑首轮,「历史」看每轮明细与错误。

## 数据流与健壮性(chat-sync 规则移植)

```
本地微信库(queries 只读) → 映射 → PG upsert(幂等,chat.sessions/messages)
调度内核 15s 心跳;单任务不重叠;interval/daily/manual;退出中止在跑轮次
```

| chat-sync 规则               | 本模块对应                                         |
| ---------------------------- | -------------------------------------------------- |
| 游标+1s 防同秒漏拉           | 微信库 sortSeq keyset 严格大于游标(天然无同秒问题) |
| lastTimestamp 预筛跳过       | lastTimestamp(ms)≤游标且 5 分钟内实拉过 → 跳过     |
| 5 分钟兜底重拉               | `last_fetch_at` 超 5 分钟强制重拉                  |
| 无消息表 30 分钟短期记忆     | 拉取 0 行且无游标 → `no_msg_at` 记忆 30 分钟       |
| 未来时间戳不推进游标         | 推进量取单调 sortSeq;时间戳仅参与预筛              |
| 单会话 90s 超时:入库不推游标 | 原样(超时会话下轮续传)                             |
| 批量幂等 upsert              | 500/批 + ON CONFLICT(media_path 只补空不覆盖)      |
| 失败重试/退避、降噪          | 失败会话游标不动,下轮自动补;明细在运行历史         |
| 单实例锁                     | 调度层 running 单任务不重叠                        |

目标表创建是幂等的:`CREATE ... IF NOT EXISTS` + 缺约束补约束 + 缺列 `ADD COLUMN IF NOT EXISTS`,
对旧库只增不改。upsert 键:`sessions(wxid)`、`messages(session_wxid, local_id)`。

## 与旧 chat-sync 共存

- 不需要清空 PG:表结构兼容、键一致、upsert 幂等,新旧写入方互不破坏;
  `media_path/media_md5` 双方均"先写保留、后写只补空",chat-sync 已归档的
  `file:///D:/software/a_data/chat-sync/media/...` 路径不会被覆盖。
- 2026-09-06 已禁用 Windows 任务计划 `CipherTalkChatSync`(可 `schtasks /Change /TN
CipherTalkChatSync /ENABLE` 恢复),避免两套游标重复拉取。chat-sync 目录文件原样保留。
- 可选干净基线(仅当想彻底以新解析重灌):先确认旧脚本停用,再
  `TRUNCATE chat.sessions, chat.messages;`(注意外键顺序),随后在应用里「立即执行」一轮
  全量(游标在本地,与 PG 内容无关,清表不影响增量正确性)。

## 安全与限制

- 口令经 safeStorage(enc1)密文存本地 `report_job.params.target.pw`,渲染层只见 hasPassword;
- 上报会把客户聊天内容发往外部数据库——新建卡片含隐私警示;
- **媒体归档**(与聊天媒体渲染共用缓存目录,数据对齐):
  图片/视频/文件消息归档到**缓存目录** `<cacheRoot>/media/<账号>/`(与解密产物同目录,命名沿用
  缓存规范:`<md5>_orig|thumb|hd.<ext>` 图、`<md5>_video.<ext>` 视频、`<md5>_file.<ext>` 文件);
  **PG `media_path` 存相对缓存根的地址 `media/<账号>/<文件名>`**(正斜杠),读取方用缓存目录
  (设置 → 偏好与数据 的缓存路径)拼接即得真实文件;仅目标为空时写入;语音/表情仅补 md5;
  单轮归档/补全各限量 200,失败或缺源(微信延迟下载)留空下轮自动续。
- 运行历史保留:每任务最近 200 条且 ≤30 天,自动清理;
- 同来源账号同类型任务唯一(创建/启用时校验),避免重复上报。

## 扩展位

任务类型按 Runner 注册制隔离(scheduler → `runChatSyncJob`),新增类型(如 webhook 上报、
运营指标快照、媒体归档导出)不改调度内核,只需补 Runner + 表单类型。

## 排障

- 目标不可达:本轮 fail,历史与任务行可见原因;游标不推进,恢复后自动续传;
- 某会话持续失败/超时:该会话游标不动,其余会话不受影响;
- 来源账号未导入密钥:任务失败提示去「微信数据」导入;
- 日志:统一日志 `report` 通道(app-YYYYMMDD.log),运行历史自带错误明细。
