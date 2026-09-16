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
  (设置 → 偏好与数据 的缓存路径)拼接即得真实文件;仅目标为空时写入;语音为 `<serverId|localId>_voice.wav`(见下节)、表情仅补 md5;
  单轮归档/补全各限量 200,失败或缺源(微信延迟下载)留空下轮自动续。
- 运行历史保留:每任务最近 200 条且 ≤30 天,自动清理;
- 同来源账号同类型任务唯一(创建/启用时校验),避免重复上报。

## 语音消息:从「[语音] 占位」到可读文本

微信语音在库里是 SILK 二进制 + 一条只有 `<voicemsg voicelength="8000"/>` 的 XML,消息正文解析出来**只有 `[语音]` 占位**。
读取层本来会把已转写的文本合流进正文(见 `media/voiceTranscript.ts`),但那条合流只在 `skipEnrich=false` 时发生,
而**批量上报走的就是 skipEnrich** —— 所以不做处理的话,PG 里的语音永远只有 `[语音]`,下游(AI / RAG / 报表)看不到语音说了什么。

本模块为此加了三件事(2026-09-16):

| 环节 | 做什么 | 位置 |
| --- | --- | --- |
| 合流 | 会话收尾时对整批消息跑一次 `decorateVoiceTranscripts`,已转写的直接进正文 | `chatSyncRunner`(会话收尾) |
| 落库 | `messages` 增列 **`voice_text`**(转写文本)与 **`voice_duration_ms`**(时长,来自 XML `voicelength`,**未转写也有**);正文同步变成 `[语音] 8″ 文本` | `pgWriter` / `report/messageRow.ts` |
| 转写 | 每轮按预算调腾讯云一句话识别:SILK 直传、产物写 `<cache>/media/<账号>/voices/<id>.txt`,完事回写 PG | `chatSyncRunner.transcribeVoiceBatch` |
| 归档 | 语音按 WAV 归档到 `archive/<serverId|localId>_voice.wav` 并写 `media_path`(与图片/视频同一条管线) | `report/mediaArchive.ts` |

**预算与节流**(任务表单里的「语音转写 N 条/轮」,默认 5,0=关闭):

- 预算 = **尝试次数**(含失败),每轮封顶;同一段语音连续失败 3 次后本轮起不再尝试(进程内记忆,重启复位);
- 挑选规则:新→旧、跳过已转写、跳过 >60s(腾讯云一句话识别上限)、按缓存名去重(分片库可能重复);
- 先转**本轮新入库**的语音,剩余预算给**历史仍是 `[语音]`** 的行补写(历史行早就过了游标,不会再被扫到);
- 转写是网络调用(单条 1~3s),放在媒体阶段(游标已落库之后),超时/中断不影响入库;
- 腾讯云 ASR 未配置时**静默跳过**并只在日志提示一次(不刷屏、不报错)。

**命名/口径只有一处**(纯函数,零依赖,自检覆盖):`media/voiceText.ts`
—— 缓存名 `<serverId|localId>.wav`、转写产物同名 `.txt`、正文 `[语音] N″ 文本`、
挑选与归档命名都在这里;`report/messageText.ts` 放类型名/占位正文。两个文件都不 import 本地模块,
所以 `node --experimental-strip-types scripts/report-voice-selftest.mjs` 能直接跑(仓库 src 里是无扩展名导入,node 的 ESM 解析器不认)。

**为什么语音归档 WAV 而不是原始 SILK**:SILK 小约 20 倍,但下游拿到还得再解码;语音在真实账号里很稀疏
(实测某门店号 10 天 11 条 ≈ 3MB,与图片同量级),不值得为省这点空间牺牲可用性。

**已知边界**:

- 历史行只补文本(转写成功时顺手归档音频);转写一直失败的语音不会单独归档音频;
- `msg_type` 命名里 40 也叫「语音消息」,但解析/转写只认 34(微信语音的本地类型);
- 转写走第三方云(腾讯云),语音内容会离开本机 —— 与「上报到外部 PG」同级的隐私事项,已在设置页明示。

## 扩展位

任务类型按 Runner 注册制隔离(scheduler → `runChatSyncJob`),新增类型(如 webhook 上报、
运营指标快照、媒体归档导出)不改调度内核,只需补 Runner + 表单类型。

## 排障

- 目标不可达:本轮 fail,历史与任务行可见原因;游标不推进,恢复后自动续传;
- 某会话持续失败/超时:该会话游标不动,其余会话不受影响;
- 来源账号未导入密钥:任务失败提示去「微信数据」导入;
- **语音没有转写**:① 腾讯云 ASR 未配置(上报日志里只有一条提示,不报错)→ 设置 → 微信数据 → 语音转写;
  ② 任务表单「语音转写」是 0;③ 语音 >60s(超上限直接跳过);
  ④ 日志出现「**在 VoiceInfo 里没找到这条语音**」:多半是时间单位对不上 —— VoiceInfo.create_time 存**秒**
  (与消息表一致),而渲染层传的是毫秒;voiceTimeCandidates() 会按"调用方单位优先、另一种兜底"各试一次,
  若仍 miss 则是微信侧确实没这条语音的 SILK(实测最新一条语音就还没落 VoiceInfo,属正常跳过)。库侧自查:
  `SELECT count(*) FILTER (WHERE voice_text IS NOT NULL) AS done, count(*) AS total FROM chat.messages WHERE msg_type = '语音消息';`
- **语音链路冒烟**(需要真库,不进 `test:all`):`PGHOST=… PGPORT=… PGUSER=… PGPASSWORD=… PGDATABASE=… npm run test:report-voice-pg`
  —— 补列 / 15 列 upsert / 转写回写 / 历史补写查询全在事务里验一遍并回滚;
- 日志:统一日志 `report` 通道(app-YYYYMMDD.log),运行历史自带错误明细;
- **改主进程代码后必须重启应用**:实测 dev 下 electron-vite 不会热重启主进程(进程号与内存状态都不变),
  语音/上报这些跑在主进程里的能力,不重启就还是旧逻辑在跑。

## 长任务体验

- 任务行实时回显同步进度(会话 x/y、新增数、媒体归档阶段),运行中可点「停止」取消本轮;
- 「每轮会话数」可将首轮全量切成多轮(未处理会话游标不动,下轮自动续),配合「单轮上限」控制单次运行时长;
- 同步期间主进程让出事件循环(页/批/会话间隙),并跳过逐页联系人 enrich(收齐后按会话一次性 enrich),
  避免窗口无响应;写库批 1000。
