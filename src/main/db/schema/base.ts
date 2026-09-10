/**
 * 基础表结构（幂等 DDL，每次启动都跑一遍 IF NOT EXISTS）。
 *
 * 分工：
 * - 本文件 = 表与索引的**当前形状**（新装库由此建成；老库靠 IF NOT EXISTS 补齐新增表）。
 * - `columns.ts` = 老库补列（CREATE TABLE IF NOT EXISTS 不会给既有表加列）。
 * - `migrations.ts` = **一次性数据迁移**（改形状/搬数据/清旧表），按 user_version 门控，只跑一次。
 *
 * 改表时的约定：新增表/索引 → 直接写这里；改既有表的形状或搬数据 → 写进 migrations.ts。
 */

/** 业务核心表（工作台 / 问题闭环 / 渠道 / 上报） */
export const CORE_TABLES: string[] = [
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

  // 全局配置（门控阈值 / 频控 / 时段窗口 / 自动总开关）
  `CREATE TABLE IF NOT EXISTS app_config (
    key TEXT PRIMARY KEY,
    value TEXT
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
  // 问题的证据消息（微信消息的副本；seq=微信 sortSeq，用于去重与时间线排序）
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
  /*
   * 群级分析状态（每账号每群一行）：增量水位 + 自动分析节流戳。
   * 这些状态原先以 `issue.wm:<wxid>:<group>` / `issue.groupAt:<wxid>:<group>` 的 JSON 串
   * 塞在 app_config 里 —— 不可查询、无类型、无清理（清空群用 setConfig(key,'') 当删除，
   * 留下一堆空行；群删了键还在）。独立成表后可 SQL 巡检、可随群级联清理。
   */
  `CREATE TABLE IF NOT EXISTS issue_group_state (
    account_wxid TEXT NOT NULL,
    group_username TEXT NOT NULL,
    wm_at INTEGER,
    wm_msg_time INTEGER,
    wm_sort_seq INTEGER,
    last_at INTEGER,
    last_method TEXT,
    last_count INTEGER,
    last_error TEXT,
    coverage_msgs INTEGER,
    coverage_truncated INTEGER NOT NULL DEFAULT 0,
    updated_at INTEGER,
    PRIMARY KEY (account_wxid, group_username)
  )`,
  // 账号级分析状态（每账号一行）：全量重析的最近结果与失败标记（原先同样是 app_config 里的 JSON 串）
  `CREATE TABLE IF NOT EXISTS issue_account_state (
    account_wxid TEXT PRIMARY KEY,
    last_at INTEGER,
    last_method TEXT,
    last_count INTEGER,
    last_groups INTEGER,
    last_groups_total INTEGER,
    last_capped INTEGER NOT NULL DEFAULT 0,
    last_cancelled INTEGER NOT NULL DEFAULT 0,
    fail_at INTEGER,
    fail_error TEXT,
    updated_at INTEGER
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

  // 工作台回答反馈(有用/没用;每条消息至多一条,重复提交即覆盖)
  `CREATE TABLE IF NOT EXISTS wb_feedback (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id INTEGER NOT NULL,
    message_id INTEGER NOT NULL,
    value INTEGER NOT NULL,
    reason TEXT,
    created_at INTEGER NOT NULL
  )`,

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
  )`,
  // 渠道接收文件索引(飞书等外部渠道下载的图片/文件):清理/统计/按渠道管理均基于此
  `CREATE TABLE IF NOT EXISTS im_file_record (
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
  )`,

  // ── 数据上报·定时任务：任务配置 / 增量游标 / 运行历史 ──
  `CREATE TABLE IF NOT EXISTS report_job (
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
  )`,
  `CREATE TABLE IF NOT EXISTS report_cursor (
    job_id INTEGER NOT NULL,
    session_wxid TEXT NOT NULL,
    cursor_seq INTEGER NOT NULL DEFAULT 0,
    cursor_ms INTEGER NOT NULL DEFAULT 0,
    last_fetch_at INTEGER,
    no_msg_at INTEGER,
    PRIMARY KEY (job_id, session_wxid)
  )`,
  `CREATE TABLE IF NOT EXISTS report_run (
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
  )`
]

/**
 * 索引（幂等）。
 * 审计/日志表按时间倒序取最新一页是它们的唯一访问形态，之前零索引 → 未来全表扫。
 */
export const CORE_INDEXES: string[] = [
  `CREATE INDEX IF NOT EXISTS idx_chat_session_t ON chat_session(updated_at DESC)`,
  `CREATE INDEX IF NOT EXISTS idx_chat_msg_s ON chat_message(session_id, id)`,
  // 问题监控:列表按 (wxid,status,occur_at) 过滤排序;证据消息按 issue_id 计数/取最新
  `CREATE INDEX IF NOT EXISTS idx_issue_fb_scope ON issue_feedback(wxid, status, occur_at DESC)`,
  `CREATE INDEX IF NOT EXISTS idx_issue_fb_group ON issue_feedback(wxid, group_username, status)`,
  `CREATE INDEX IF NOT EXISTS idx_issue_fb_msg_issue ON issue_feedback_msg(issue_id, seq DESC)`,
  // 群级分析状态：按群读一行；巡检「水位过期」按 last_at 排序
  `CREATE INDEX IF NOT EXISTS idx_issue_group_state_last ON issue_group_state(account_wxid, last_at DESC)`,
  // 审计日志：最近 N 条列表 + 保留期清理
  `CREATE INDEX IF NOT EXISTS idx_im_audit_created ON im_audit(created_at DESC)`,
  `CREATE INDEX IF NOT EXISTS idx_im_audit_chat ON im_audit(account_id, chat_id, created_at DESC)`,
  `CREATE INDEX IF NOT EXISTS idx_feishu_send_log_created ON feishu_send_log(created_at DESC)`,
  `CREATE INDEX IF NOT EXISTS idx_send_log_created ON send_log(created_at DESC)`,
  `CREATE UNIQUE INDEX IF NOT EXISTS idx_wb_feedback_msg ON wb_feedback (message_id)`,
  `CREATE UNIQUE INDEX IF NOT EXISTS idx_im_file_record_msg ON im_file_record (channel, message_id)`,
  `CREATE INDEX IF NOT EXISTS idx_report_run_job ON report_run (job_id, id DESC)`,
  `CREATE INDEX IF NOT EXISTS idx_report_job_next ON report_job (enabled, next_at)`
]
