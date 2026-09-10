import type Database from 'better-sqlite3-multiple-ciphers'

/**
 * 本地库 schema（对应方案文档 §5 数据模型）
 * 消息本体存微信 DB，本地只存密钥、决策与审计数据。
 */
const SCHEMA_VERSION = 2

const TABLES: string[] = [
  // 客户档案
  `CREATE TABLE IF NOT EXISTS customer (
    id INTEGER PRIMARY KEY,
    wxid TEXT UNIQUE,
    nickname TEXT,
    remark TEXT,
    tags TEXT,
    tier TEXT DEFAULT 'normal',
    profile TEXT,
    last_incident_at INTEGER,
    created_at INTEGER
  )`,

  // 微信 DB 密钥（外部注入，加密存储，不落明文）
  `CREATE TABLE IF NOT EXISTS key_store (
    id INTEGER PRIMARY KEY,
    wxid TEXT UNIQUE,
    db_path TEXT,
    key_encrypted TEXT,
    source TEXT,
    status TEXT DEFAULT 'pending',
    imported_at INTEGER,
    updated_at INTEGER
  )`,

  // 会话状态（支撑门控 G1/G3/G4 与转人工）
  `CREATE TABLE IF NOT EXISTS session (
    id TEXT PRIMARY KEY,
    wxid TEXT,
    status TEXT DEFAULT 'normal',
    last_msg_time INTEGER,
    auto_streak INTEGER DEFAULT 0,
    updated_at INTEGER
  )`,

  // 全局配置（门控阈值 / 频控 / 时段窗口 / 自动总开关）
  `CREATE TABLE IF NOT EXISTS app_config (
    key TEXT PRIMARY KEY,
    value TEXT
  )`,

  // 条件规则 P1~P4（P5~P8 为引擎内建 source 分支逻辑）
  `CREATE TABLE IF NOT EXISTS tier_rule (
    id INTEGER PRIMARY KEY,
    priority INTEGER,
    name TEXT,
    enabled INTEGER DEFAULT 1,
    condition_type TEXT,
    condition TEXT,
    action TEXT
  )`,

  // 知识库条目
  `CREATE TABLE IF NOT EXISTS knowledge_item (
    id INTEGER PRIMARY KEY,
    category TEXT,
    keywords TEXT,
    question TEXT,
    answer TEXT,
    scope TEXT DEFAULT 'public',
    has_vars INTEGER DEFAULT 0,
    expires_at INTEGER,
    priority INTEGER DEFAULT 0,
    updated_at INTEGER
  )`,

  // 回复候选与决策（含状态机）
  `CREATE TABLE IF NOT EXISTS reply_decision (
    id INTEGER PRIMARY KEY,
    session_id TEXT,
    target_key TEXT,
    mode TEXT,
    source TEXT,
    status TEXT DEFAULT 'generated',
    suggestions TEXT,
    chosen TEXT,
    chosen_at INTEGER
  )`,

  // 发送日志（审计）
  `CREATE TABLE IF NOT EXISTS send_log (
    id INTEGER PRIMARY KEY,
    session_id TEXT,
    message TEXT,
    mode TEXT,
    source TEXT,
    result TEXT,
    error_reason TEXT,
    verified INTEGER DEFAULT 0,
    verified_at INTEGER,
    created_at INTEGER
  )`,

  // IM 审计/任务（合并原 im_command_log + im_task：一条入站 = 一行，任务生命周期挂同一行）
  `CREATE TABLE IF NOT EXISTS im_audit (
    id INTEGER PRIMARY KEY,
    account_id INTEGER,
    chat_id TEXT,
    session_id INTEGER,
    sender_open_id TEXT,
    chat_type TEXT,
    kind TEXT,
    text TEXT,
    status TEXT,
    progress TEXT,
    result TEXT,
    reply_len INTEGER,
    tools TEXT,
    elapsed_ms INTEGER,
    error TEXT,
    created_at INTEGER,
    started_at INTEGER,
    finished_at INTEGER
  )`,

  // 飞书出站消息审计（告警推送/测试/工具发送）
  `CREATE TABLE IF NOT EXISTS feishu_send_log (
    id INTEGER PRIMARY KEY,
    target_kind TEXT,
    target_id TEXT,
    target_name TEXT,
    content TEXT,
    source TEXT,
    result TEXT,
    error TEXT,
    message_id TEXT,
    created_at INTEGER
  )`,

  // 群问题反馈（看板：LLM/规则从群消息提取 + 人工处理状态）
  `CREATE TABLE IF NOT EXISTS issue_feedback (
    id INTEGER PRIMARY KEY,
    key TEXT UNIQUE,
    wxid TEXT,
    group_username TEXT,
    group_name TEXT,
    type TEXT DEFAULT '其他',
    title TEXT,
    summary TEXT,
    occur_at INTEGER,
    status TEXT DEFAULT 'open',
    method TEXT DEFAULT 'rule',
    created_at INTEGER,
    updated_at INTEGER
  )`,
  `CREATE TABLE IF NOT EXISTS issue_feedback_msg (
    id INTEGER PRIMARY KEY,
    issue_id INTEGER NOT NULL,
    seq INTEGER,
    msg_time INTEGER,
    sender_name TEXT,
    sender_username TEXT,
    is_send INTEGER DEFAULT 0,
    is_team INTEGER DEFAULT 0,
    text TEXT,
    image_md5 TEXT,
    local_type INTEGER,
    FOREIGN KEY (issue_id) REFERENCES issue_feedback(id) ON DELETE CASCADE
  )`,

  // 智能体（客服人设）：名称/描述/风格/自定义提示词，供回复建议 LLM 动态使用
  `CREATE TABLE IF NOT EXISTS ai_agent (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    description TEXT DEFAULT '',
    style TEXT DEFAULT 'warm',
    prompt TEXT DEFAULT '',
    created_at INTEGER,
    updated_at INTEGER
  )`,

  // 团队客服成员（全局标识）：某账号视角下的“我方同事”联系人，分析/建议时视同己方
  `CREATE TABLE IF NOT EXISTS team_member (
    id INTEGER PRIMARY KEY,
    account_wxid TEXT NOT NULL,
    username TEXT NOT NULL,
    label TEXT DEFAULT '',
    created_at INTEGER,
    UNIQUE (account_wxid, username)
  )`,

  // AI 助手会话（页面 AI 菜单;wxid 空 = 未连接账号的通用会话）
  `CREATE TABLE IF NOT EXISTS chat_session (
    id INTEGER PRIMARY KEY,
    wxid TEXT DEFAULT '',
    title TEXT NOT NULL,
    agent_id TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  )`,
  // AI 助手消息(role=user/assistant/system;kind=text/tool_call/tool_result/error;meta JSON)
  `CREATE TABLE IF NOT EXISTS chat_message (
    id INTEGER PRIMARY KEY,
    session_id INTEGER NOT NULL,
    role TEXT NOT NULL,
    kind TEXT DEFAULT 'text',
    content TEXT NOT NULL DEFAULT '',
    meta TEXT,
    created_at INTEGER NOT NULL,
    FOREIGN KEY (session_id) REFERENCES chat_session(id) ON DELETE CASCADE
  )`,
  `CREATE INDEX IF NOT EXISTS idx_chat_session_t ON chat_session(updated_at DESC)`,
  `CREATE INDEX IF NOT EXISTS idx_chat_msg_s ON chat_message(session_id, id)`,
  // 问题监控:列表按 (wxid,status,occur_at) 过滤排序;证据消息按 issue_id 计数/取最新
  // 之前两张表零索引 → 每行 COUNT(*) 与 ORDER BY seq DESC LIMIT 1 都是全表扫(N×M)
  `CREATE INDEX IF NOT EXISTS idx_issue_fb_scope ON issue_feedback(wxid, status, occur_at DESC)`,
  `CREATE INDEX IF NOT EXISTS idx_issue_fb_group ON issue_feedback(wxid, group_username, status)`,
  `CREATE INDEX IF NOT EXISTS idx_issue_fb_msg_issue ON issue_feedback_msg(issue_id, seq DESC)`,
  // IM 渠道账号(飞书机器人等;config 含 appId/secret,secret 以 safeStorage enc1 密文落库)
  `CREATE TABLE IF NOT EXISTS im_channel_account (
    id INTEGER PRIMARY KEY,
    channel TEXT NOT NULL DEFAULT 'feishu',
    name TEXT NOT NULL,
    config TEXT NOT NULL DEFAULT '{}',
    enabled INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  )`,
  // IM 外部聊天 → 本地 AI 会话映射(群/私聊各自独立上下文)
  `CREATE TABLE IF NOT EXISTS im_chat_map (
    id INTEGER PRIMARY KEY,
    account_id INTEGER NOT NULL,
    external_chat_id TEXT NOT NULL,
    session_id INTEGER NOT NULL,
    external_name TEXT DEFAULT '',
    created_at INTEGER NOT NULL,
    UNIQUE (account_id, external_chat_id)
  )`
]

export function migrate(db: Database.Database): void {
  for (const sql of TABLES) db.exec(sql)
  // 工作台回答反馈(有用/没用;每条消息至多一条,重复提交即覆盖)
  db.exec(`CREATE TABLE IF NOT EXISTS wb_feedback (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id INTEGER NOT NULL,
    message_id INTEGER NOT NULL,
    value INTEGER NOT NULL,
    reason TEXT,
    created_at INTEGER NOT NULL
  )`)
  db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_wb_feedback_msg ON wb_feedback (message_id)')
  // 渠道接收文件索引(飞书等外部渠道下载的图片/文件):清理/统计/按渠道管理均基于此
  db.exec(`CREATE TABLE IF NOT EXISTS im_file_record (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    channel TEXT NOT NULL,
    account_id INTEGER NOT NULL,
    message_id TEXT NOT NULL,
    sender_id TEXT,
    chat_id TEXT,
    kind TEXT NOT NULL,
    file_name TEXT,
    rel_path TEXT NOT NULL,
    bytes INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL
  )`)
  db.exec(
    'CREATE UNIQUE INDEX IF NOT EXISTS idx_im_file_record_msg ON im_file_record (channel, message_id)'
  )
  // ── 数据上报·定时任务：任务配置 / 增量游标 / 运行历史 ──
  db.exec(`CREATE TABLE IF NOT EXISTS report_job (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    type TEXT NOT NULL DEFAULT 'chat_sync',
    enabled INTEGER NOT NULL DEFAULT 0,
    schedule_kind TEXT NOT NULL DEFAULT 'manual',
    interval_sec INTEGER NOT NULL DEFAULT 0,
    daily_time TEXT DEFAULT '',
    params TEXT NOT NULL DEFAULT '{}',
    last_status TEXT,
    last_summary TEXT,
    last_at INTEGER,
    next_at INTEGER,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  )`)
  db.exec(`CREATE TABLE IF NOT EXISTS report_cursor (
    job_id INTEGER NOT NULL,
    session_wxid TEXT NOT NULL,
    cursor_seq INTEGER NOT NULL DEFAULT 0,
    cursor_ms INTEGER NOT NULL DEFAULT 0,
    last_fetch_at INTEGER,
    no_msg_at INTEGER,
    PRIMARY KEY (job_id, session_wxid)
  )`)
  db.exec(`CREATE TABLE IF NOT EXISTS report_run (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    job_id INTEGER NOT NULL,
    trigger TEXT NOT NULL DEFAULT 'auto',
    status TEXT NOT NULL,
    added INTEGER NOT NULL DEFAULT 0,
    sessions_ok INTEGER NOT NULL DEFAULT 0,
    sessions_skip INTEGER NOT NULL DEFAULT 0,
    errors TEXT,
    started_at INTEGER NOT NULL,
    ended_at INTEGER,
    duration_ms INTEGER
  )`)
  db.exec('CREATE INDEX IF NOT EXISTS idx_report_run_job ON report_run (job_id, id DESC)')
  db.exec('CREATE INDEX IF NOT EXISTS idx_report_job_next ON report_job (enabled, next_at)')
  // 历史版本曾临时内置话术库(phrase_book),功能已下线:清理旧库残留表
  db.exec('DROP TABLE IF EXISTS phrase_book')
  // 增量列迁移：issue_feedback.auto_done（自动闭环标记：unreplied 问题检测到回复后自动关闭）
  ensureColumn(db, 'issue_feedback', 'auto_done', 'INTEGER NOT NULL DEFAULT 0')
  // 增量列迁移：follow_up（跟进中：客服已回复未闭环）
  ensureColumn(db, 'issue_feedback', 'follow_up', 'INTEGER NOT NULL DEFAULT 0')
  // 增量列迁移：assignee（跟进人：团队客服成员 username，NULL = 未指派）
  ensureColumn(db, 'issue_feedback', 'assignee', 'TEXT')
  // 增量列迁移：severity（严重度：紧急/高/一般，分析提取时写入）
  ensureColumn(db, 'issue_feedback', 'severity', "TEXT NOT NULL DEFAULT '一般'")
  // 增量列迁移：need_confirm（疑似桶：规则弱命中，人工确认或归档后退出）
  ensureColumn(db, 'issue_feedback', 'need_confirm', 'INTEGER NOT NULL DEFAULT 0')
  // 增量列迁移：reopen_count / reopened_from（复发计数与上次闭环议题 id）
  ensureColumn(db, 'issue_feedback', 'reopen_count', 'INTEGER NOT NULL DEFAULT 0')
  ensureColumn(db, 'issue_feedback', 'reopened_from', 'INTEGER')
  // 增量列迁移：customers（涉及的客户昵称 JSON 数组，供复发/统计归一）
  ensureColumn(db, 'issue_feedback', 'customers', 'TEXT')
  // 增量列迁移：follow_up_at（客服最后一次回复时间，跟进超时据此动态计算；NULL=规则未判定或未回复）
  ensureColumn(db, 'issue_feedback', 'follow_up_at', 'INTEGER')
  // 增量列迁移：resolved_at（闭环时间：置 done/stalled 时写入，重开清空）——趋势/今日解决口径专用，
  // 避免 upsert 内容刷新 updated_at 时把老问题的解决日算到今天
  ensureColumn(db, 'issue_feedback', 'resolved_at', 'INTEGER')
  // 增量列迁移：证据行发送人 username / 是否团队客服（客户身份归并、复发识别、时间线我方标记）
  ensureColumn(db, 'issue_feedback_msg', 'sender_username', 'TEXT')
  ensureColumn(db, 'issue_feedback_msg', 'is_team', 'INTEGER NOT NULL DEFAULT 0')
  // 增量列迁移：archived_from（归档前状态）——区分「人工判定不是问题」(open) 与「历史已解决归档」(done/stalled)：
  // 前者是 LLM 反例样本，后者仍要计入累计闭环率
  ensureColumn(db, 'issue_feedback', 'archived_from', 'TEXT')
  // 增量列迁移：chat_session.caps（能力分层挂载集合 JSON：{v:1,names:[...]}，会话级渐进式工具可见性）
  ensureColumn(db, 'chat_session', 'caps', 'TEXT')
  // 增量列迁移:chat_session.workspace(工作区任务绑定的真实目录;NULL=未绑定,仅查询模式)
  ensureColumn(db, 'chat_session', 'workspace', 'TEXT')

  // ── 营销增长(growth)域: Phase 0 建表(全部追加;后续阶段列迁移走 ensureColumn) ──
  db.exec(
    "CREATE TABLE IF NOT EXISTS growth_store (\n  id INTEGER PRIMARY KEY AUTOINCREMENT,\n  brand_name TEXT NOT NULL DEFAULT '',\n  name TEXT NOT NULL,\n  city TEXT NOT NULL DEFAULT '',\n  address TEXT NOT NULL DEFAULT '',\n  biz_type TEXT NOT NULL DEFAULT '',\n  poi_json TEXT NOT NULL DEFAULT '[]',\n  profile_json TEXT NOT NULL DEFAULT '{}',\n  enabled INTEGER NOT NULL DEFAULT 1,\n  created_at INTEGER NOT NULL,\n  updated_at INTEGER NOT NULL\n)"
  )
  db.exec(
    "CREATE TABLE IF NOT EXISTS growth_brand_profile (\n  id INTEGER PRIMARY KEY AUTOINCREMENT,\n  name TEXT NOT NULL DEFAULT '',\n  profile_json TEXT NOT NULL DEFAULT '{}',\n  created_at INTEGER NOT NULL,\n  updated_at INTEGER NOT NULL\n)"
  )
  db.exec(
    "CREATE TABLE IF NOT EXISTS growth_content (\n  id INTEGER PRIMARY KEY AUTOINCREMENT,\n  kind TEXT NOT NULL DEFAULT 'unknown',\n  origin TEXT NOT NULL DEFAULT '',\n  platform_item_id TEXT NOT NULL DEFAULT '',\n  store_id INTEGER,\n  title TEXT NOT NULL DEFAULT '',\n  content_text TEXT NOT NULL DEFAULT '',\n  author_name TEXT NOT NULL DEFAULT '',\n  author_id TEXT NOT NULL DEFAULT '',\n  link TEXT NOT NULL DEFAULT '',\n  published_at INTEGER,\n  tags_json TEXT NOT NULL DEFAULT '[]',\n  usage TEXT NOT NULL DEFAULT 'ref',\n  interactions_json TEXT NOT NULL DEFAULT '{}',\n  extra_json TEXT NOT NULL DEFAULT '{}',\n  score REAL NOT NULL DEFAULT 0,\n  status TEXT NOT NULL DEFAULT 'new',\n  note TEXT NOT NULL DEFAULT '',\n  dedupe_key TEXT,\n  created_at INTEGER NOT NULL,\n  updated_at INTEGER NOT NULL\n)"
  )
  db.exec(
    'CREATE UNIQUE INDEX IF NOT EXISTS idx_growth_content_dedupe\n  ON growth_content (dedupe_key) WHERE dedupe_key IS NOT NULL'
  )
  db.exec(
    'CREATE INDEX IF NOT EXISTS idx_growth_content_created\n  ON growth_content (created_at DESC)'
  )
  db.exec(
    "CREATE TABLE IF NOT EXISTS growth_asset (\n  id INTEGER PRIMARY KEY AUTOINCREMENT,\n  content_id INTEGER NOT NULL,\n  kind TEXT NOT NULL DEFAULT 'image',\n  sha256 TEXT NOT NULL DEFAULT '',\n  mime TEXT NOT NULL DEFAULT '',\n  size INTEGER NOT NULL DEFAULT 0,\n  width INTEGER NOT NULL DEFAULT 0,\n  height INTEGER NOT NULL DEFAULT 0,\n  duration_ms INTEGER NOT NULL DEFAULT 0,\n  rel_path TEXT NOT NULL DEFAULT '',\n  thumb_rel_path TEXT NOT NULL DEFAULT '',\n  source_mark TEXT NOT NULL DEFAULT '',\n  created_at INTEGER NOT NULL\n)"
  )
  db.exec('CREATE INDEX IF NOT EXISTS idx_growth_asset_content ON growth_asset (content_id)')
  db.exec(
    "CREATE TABLE IF NOT EXISTS growth_decomp (\n  id INTEGER PRIMARY KEY AUTOINCREMENT,\n  content_id INTEGER NOT NULL,\n  model_ver TEXT NOT NULL DEFAULT '',\n  structure_json TEXT NOT NULL DEFAULT '{}',\n  visual_json TEXT NOT NULL DEFAULT '{}',\n  comment_topics_json TEXT NOT NULL DEFAULT '[]',\n  created_at INTEGER NOT NULL\n)"
  )
  db.exec(
    'CREATE UNIQUE INDEX IF NOT EXISTS idx_growth_decomp_content ON growth_decomp (content_id)'
  )
  db.exec(
    "CREATE TABLE IF NOT EXISTS growth_subscription (\n  id INTEGER PRIMARY KEY AUTOINCREMENT,\n  name TEXT NOT NULL,\n  source_type TEXT NOT NULL DEFAULT 'thirdparty',\n  vendor TEXT NOT NULL DEFAULT '',\n  city TEXT NOT NULL DEFAULT '',\n  biz_type TEXT NOT NULL DEFAULT '',\n  target_kind TEXT NOT NULL DEFAULT 'keyword',\n  target TEXT NOT NULL DEFAULT '',\n  store_id INTEGER,\n  enabled INTEGER NOT NULL DEFAULT 0,\n  interval_hours INTEGER NOT NULL DEFAULT 24,\n  next_at INTEGER,\n  last_status TEXT NOT NULL DEFAULT '',\n  last_at INTEGER,\n  last_error TEXT NOT NULL DEFAULT '',\n  created_at INTEGER NOT NULL,\n  updated_at INTEGER NOT NULL\n)"
  )
  db.exec(
    'CREATE INDEX IF NOT EXISTS idx_growth_sub_next ON growth_subscription (enabled, next_at)'
  )
  db.exec(
    "CREATE TABLE IF NOT EXISTS growth_crawl_task (\n  id INTEGER PRIMARY KEY AUTOINCREMENT,\n  subscription_id INTEGER NOT NULL,\n  trigger TEXT NOT NULL DEFAULT 'auto',\n  status TEXT NOT NULL DEFAULT 'running',\n  fetched INTEGER NOT NULL DEFAULT 0,\n  inserted INTEGER NOT NULL DEFAULT 0,\n  error TEXT NOT NULL DEFAULT '',\n  started_at INTEGER NOT NULL,\n  ended_at INTEGER\n)"
  )
  db.exec(
    'CREATE INDEX IF NOT EXISTS idx_growth_crawl_sub ON growth_crawl_task (subscription_id, id DESC)'
  )
  db.exec(
    "CREATE TABLE IF NOT EXISTS growth_remix_job (\n  id INTEGER PRIMARY KEY AUTOINCREMENT,\n  source_content_id INTEGER NOT NULL,\n  store_id INTEGER,\n  mode TEXT NOT NULL DEFAULT 'mid',\n  snapshot_json TEXT NOT NULL DEFAULT '{}',\n  status TEXT NOT NULL DEFAULT 'queued',\n  stage TEXT NOT NULL DEFAULT '',\n  progress REAL NOT NULL DEFAULT 0,\n  error TEXT NOT NULL DEFAULT '',\n  created_at INTEGER NOT NULL,\n  updated_at INTEGER NOT NULL\n)"
  )
  db.exec('CREATE INDEX IF NOT EXISTS idx_growth_remix_src ON growth_remix_job (source_content_id)')
  db.exec(
    "CREATE TABLE IF NOT EXISTS growth_remix_output (\n  id INTEGER PRIMARY KEY AUTOINCREMENT,\n  job_id INTEGER NOT NULL,\n  variant TEXT NOT NULL DEFAULT 'A',\n  title TEXT NOT NULL DEFAULT '',\n  copy_text TEXT NOT NULL DEFAULT '',\n  content_id INTEGER,\n  compliance_json TEXT NOT NULL DEFAULT '{}',\n  score REAL NOT NULL DEFAULT 0,\n  status TEXT NOT NULL DEFAULT 'draft',\n  created_at INTEGER NOT NULL\n)"
  )
  db.exec('CREATE INDEX IF NOT EXISTS idx_growth_remix_out_job ON growth_remix_output (job_id)')
  db.exec(
    "CREATE TABLE IF NOT EXISTS growth_publish_task (\n  id INTEGER PRIMARY KEY AUTOINCREMENT,\n  output_id INTEGER,\n  store_id INTEGER,\n  channel TEXT NOT NULL DEFAULT '',\n  scheduled_at INTEGER,\n  status TEXT NOT NULL DEFAULT 'pending',\n  lead_json TEXT NOT NULL DEFAULT '{}',\n  created_at INTEGER NOT NULL,\n  updated_at INTEGER NOT NULL\n)"
  )
  db.exec(
    'CREATE INDEX IF NOT EXISTS idx_growth_publish_due ON growth_publish_task (status, scheduled_at)'
  )
  db.exec(
    "CREATE TABLE IF NOT EXISTS growth_publish_result (\n  id INTEGER PRIMARY KEY AUTOINCREMENT,\n  task_id INTEGER NOT NULL,\n  remote_id TEXT NOT NULL DEFAULT '',\n  url TEXT NOT NULL DEFAULT '',\n  published_at INTEGER,\n  error TEXT NOT NULL DEFAULT '',\n  raw_json TEXT NOT NULL DEFAULT '{}',\n  created_at INTEGER NOT NULL\n)"
  )
  db.exec('CREATE INDEX IF NOT EXISTS idx_growth_pub_res_task ON growth_publish_result (task_id)')
  db.exec(
    "CREATE TABLE IF NOT EXISTS growth_metric_snapshot (\n  id INTEGER PRIMARY KEY AUTOINCREMENT,\n  target_type TEXT NOT NULL DEFAULT 'content',\n  target_id INTEGER NOT NULL,\n  channel TEXT NOT NULL DEFAULT '',\n  likes INTEGER NOT NULL DEFAULT 0,\n  collects INTEGER NOT NULL DEFAULT 0,\n  comments INTEGER NOT NULL DEFAULT 0,\n  shares INTEGER NOT NULL DEFAULT 0,\n  follows INTEGER NOT NULL DEFAULT 0,\n  leads INTEGER NOT NULL DEFAULT 0,\n  amount REAL NOT NULL DEFAULT 0,\n  output_id INTEGER,\n  captured_at INTEGER NOT NULL\n)"
  )
  db.exec(
    'CREATE INDEX IF NOT EXISTS idx_growth_metric_target\n  ON growth_metric_snapshot (target_type, target_id, captured_at)'
  )

  // 增量列迁移：growth_content.extra_json（解析媒体源信息，如 remoteMedia）
  ensureColumn(db, 'growth_content', 'extra_json', "TEXT NOT NULL DEFAULT '{}'")
  // 增量列迁移：growth_metric_snapshot.output_id（发布归因：采用的爆改产出）
  ensureColumn(db, 'growth_metric_snapshot', 'output_id', 'INTEGER')

  // ── 营销 AI 工作台: 任务 / 任务产出资产 / 会话域隔离 ──
  db.exec(
    "CREATE TABLE IF NOT EXISTS growth_ai_task (\n  id INTEGER PRIMARY KEY AUTOINCREMENT,\n  content_id INTEGER NOT NULL,\n  store_id INTEGER,\n  title TEXT NOT NULL DEFAULT '',\n  goal TEXT NOT NULL DEFAULT 'image_text',\n  status TEXT NOT NULL DEFAULT 'drafting',\n  session_id INTEGER,\n  stage TEXT NOT NULL DEFAULT 'analyze',\n  summary TEXT NOT NULL DEFAULT '',\n  created_at INTEGER NOT NULL,\n  updated_at INTEGER NOT NULL,\n  last_message_at INTEGER\n)"
  )
  db.exec(
    'CREATE INDEX IF NOT EXISTS idx_growth_task_status ON growth_ai_task (status, updated_at DESC)'
  )
  db.exec(
    "CREATE TABLE IF NOT EXISTS growth_output_asset (\n  id INTEGER PRIMARY KEY AUTOINCREMENT,\n  output_id INTEGER NOT NULL,\n  asset_id INTEGER,\n  role TEXT NOT NULL DEFAULT 'image',\n  source TEXT NOT NULL DEFAULT '',\n  prompt TEXT NOT NULL DEFAULT '',\n  note TEXT NOT NULL DEFAULT '',\n  created_at INTEGER NOT NULL\n)"
  )
  db.exec('CREATE INDEX IF NOT EXISTS idx_growth_out_asset ON growth_output_asset (output_id)')
  // 增量列迁移：chat_session.scope（会话域: 空=客服工作台, growth=营销 AI 工作台）
  ensureColumn(db, 'chat_session', 'scope', "TEXT NOT NULL DEFAULT ''")
  // 增量列迁移：growth_remix_output.task_id（候选/产出归属营销任务）
  ensureColumn(db, 'growth_remix_output', 'task_id', 'INTEGER')
  ensureColumn(db, 'growth_remix_output', 'meta_json', "TEXT NOT NULL DEFAULT '{}'")

  // ── 舆情监控: 提及 / 评论 ──
  db.exec(
    "CREATE TABLE IF NOT EXISTS growth_buzz_mention (\n  id INTEGER PRIMARY KEY AUTOINCREMENT,\n  store_id INTEGER,\n  platform TEXT NOT NULL DEFAULT '',\n  kind TEXT NOT NULL DEFAULT '',\n  url TEXT NOT NULL DEFAULT '',\n  platform_item_id TEXT NOT NULL DEFAULT '',\n  title TEXT NOT NULL DEFAULT '',\n  content_text TEXT NOT NULL DEFAULT '',\n  author_name TEXT NOT NULL DEFAULT '',\n  author_id TEXT NOT NULL DEFAULT '',\n  published_at INTEGER,\n  interactions_json TEXT NOT NULL DEFAULT '{}',\n  assets_json TEXT NOT NULL DEFAULT '[]',\n  source TEXT NOT NULL DEFAULT 'manual',\n  status TEXT NOT NULL DEFAULT 'new',\n  sentiment TEXT NOT NULL DEFAULT '',\n  score INTEGER NOT NULL DEFAULT 0,\n  risk_level TEXT NOT NULL DEFAULT '',\n  reasons_json TEXT NOT NULL DEFAULT '[]',\n  diagnosis_json TEXT NOT NULL DEFAULT '{}',\n  diagnosed_at INTEGER,\n  note TEXT NOT NULL DEFAULT '',\n  dedupe_key TEXT,\n  created_at INTEGER NOT NULL,\n  updated_at INTEGER NOT NULL\n)"
  )
  db.exec(
    'CREATE UNIQUE INDEX IF NOT EXISTS idx_growth_buzz_dedupe ON growth_buzz_mention (dedupe_key) WHERE dedupe_key IS NOT NULL'
  )
  db.exec(
    'CREATE INDEX IF NOT EXISTS idx_growth_buzz_status ON growth_buzz_mention (status, created_at DESC)'
  )
  db.exec(
    "CREATE TABLE IF NOT EXISTS growth_buzz_comment (\n  id INTEGER PRIMARY KEY AUTOINCREMENT,\n  mention_id INTEGER NOT NULL,\n  author_name TEXT NOT NULL DEFAULT '',\n  content TEXT NOT NULL DEFAULT '',\n  likes INTEGER NOT NULL DEFAULT 0,\n  is_high INTEGER NOT NULL DEFAULT 0,\n  source TEXT NOT NULL DEFAULT 'manual',\n  published_at INTEGER,\n  created_at INTEGER NOT NULL\n)"
  )
  db.exec(
    'CREATE INDEX IF NOT EXISTS idx_growth_buzz_cmt ON growth_buzz_comment (mention_id, likes DESC)'
  )
  db.pragma(`user_version = ${SCHEMA_VERSION}`)
}

/** 旧库补列（CREATE TABLE IF NOT EXISTS 不会加列）：探测后 ALTER */
function ensureColumn(db: Database.Database, table: string, column: string, ddl: string): void {
  try {
    const cols = db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]
    if (!cols.some((c) => c.name === column)) {
      db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${ddl}`)
    }
  } catch {
    /* 表不存在等：交由建表 SQL 兜底 */
  }
}

export function listTables(db: Database.Database): string[] {
  const rows = db
    .prepare(
      `SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name`
    )
    .all() as Array<{ name: string }>
  return rows.map((r) => r.name)
}
