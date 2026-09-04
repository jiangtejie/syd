import type Database from 'better-sqlite3-multiple-ciphers'

/**
 * 本地库 schema（对应方案文档 §5 数据模型）
 * 消息本体存微信 DB，本地只存密钥、决策与审计数据。
 */
const SCHEMA_VERSION = 1

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
    is_send INTEGER DEFAULT 0,
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
  // AI 助手 MCP 服务器(外部能力接入;kind=stdio|http)
  `CREATE TABLE IF NOT EXISTS ai_mcp_server (
    id INTEGER PRIMARY KEY,
    name TEXT NOT NULL,
    kind TEXT NOT NULL DEFAULT 'stdio',
    command TEXT DEFAULT '',
    args TEXT DEFAULT '[]',
    url TEXT DEFAULT '',
    timeout_sec INTEGER NOT NULL DEFAULT 30,
    confirm INTEGER NOT NULL DEFAULT 1,
    enabled INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  )`,
  // AI 助手自定义 HTTP 工具(应用内“开发工具”:模型可调用任意内部/外部只读接口)
  `CREATE TABLE IF NOT EXISTS ai_custom_tool (
    id INTEGER PRIMARY KEY,
    name TEXT NOT NULL UNIQUE,
    label TEXT DEFAULT '',
    description TEXT NOT NULL,
    method TEXT NOT NULL DEFAULT 'GET',
    url TEXT NOT NULL,
    headers TEXT DEFAULT '{}',
    params TEXT DEFAULT '[]',
    timeout_sec INTEGER NOT NULL DEFAULT 20,
    confirm INTEGER NOT NULL DEFAULT 1,
    enabled INTEGER NOT NULL DEFAULT 1,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  )`,
  // AI 助手常驻记忆(跨会话长期上下文;agent_id 空=全部智能体生效)
  `CREATE TABLE IF NOT EXISTS agent_memory (
    id INTEGER PRIMARY KEY,
    agent_id TEXT,
    content TEXT NOT NULL,
    enabled INTEGER NOT NULL DEFAULT 1,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  )`
]

export function migrate(db: Database.Database): void {
  for (const sql of TABLES) db.exec(sql)
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
