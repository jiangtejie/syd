/**
 * 营销增长(growth)域表结构（幂等 DDL）。
 * Phase 0 建表；后续阶段列迁移走 `columns.ts`，一次性数据迁移走 `migrations.ts`。
 */
export const GROWTH_TABLES: string[] = [
  `CREATE TABLE IF NOT EXISTS growth_store (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    brand_name TEXT NOT NULL DEFAULT '',
    name TEXT NOT NULL,
    city TEXT NOT NULL DEFAULT '',
    address TEXT NOT NULL DEFAULT '',
    biz_type TEXT NOT NULL DEFAULT '',
    poi_json TEXT NOT NULL DEFAULT '[]',
    profile_json TEXT NOT NULL DEFAULT '{}',
    enabled INTEGER NOT NULL DEFAULT 1,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS growth_brand_profile (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL DEFAULT '',
    profile_json TEXT NOT NULL DEFAULT '{}',
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS growth_content (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    kind TEXT NOT NULL DEFAULT 'unknown',
    origin TEXT NOT NULL DEFAULT '',
    platform_item_id TEXT NOT NULL DEFAULT '',
    store_id INTEGER,
    title TEXT NOT NULL DEFAULT '',
    content_text TEXT NOT NULL DEFAULT '',
    author_name TEXT NOT NULL DEFAULT '',
    author_id TEXT NOT NULL DEFAULT '',
    link TEXT NOT NULL DEFAULT '',
    published_at INTEGER,
    tags_json TEXT NOT NULL DEFAULT '[]',
    usage TEXT NOT NULL DEFAULT 'ref',
    interactions_json TEXT NOT NULL DEFAULT '{}',
    extra_json TEXT NOT NULL DEFAULT '{}',
    score REAL NOT NULL DEFAULT 0,
    status TEXT NOT NULL DEFAULT 'new',
    note TEXT NOT NULL DEFAULT '',
    dedupe_key TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS growth_asset (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    content_id INTEGER NOT NULL,
    kind TEXT NOT NULL DEFAULT 'image',
    sha256 TEXT NOT NULL DEFAULT '',
    mime TEXT NOT NULL DEFAULT '',
    size INTEGER NOT NULL DEFAULT 0,
    width INTEGER NOT NULL DEFAULT 0,
    height INTEGER NOT NULL DEFAULT 0,
    duration_ms INTEGER NOT NULL DEFAULT 0,
    rel_path TEXT NOT NULL DEFAULT '',
    thumb_rel_path TEXT NOT NULL DEFAULT '',
    source_mark TEXT NOT NULL DEFAULT '',
    created_at INTEGER NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS growth_decomp (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    content_id INTEGER NOT NULL,
    model_ver TEXT NOT NULL DEFAULT '',
    structure_json TEXT NOT NULL DEFAULT '{}',
    visual_json TEXT NOT NULL DEFAULT '{}',
    comment_topics_json TEXT NOT NULL DEFAULT '[]',
    created_at INTEGER NOT NULL
  )`,
  // 注: growth_subscription / growth_crawl_task（第三方采集订阅 + 抓取任务表）已随采集链路
  // 整体下线删除 —— 数据来源只剩「粘贴链接入库 / 本地导入 / 媒体重下」三条人工路径，
  // 调度器与第三方适配器已无代码引用。老库里那两张表原样留着（不影响使用），新装库不再建。
  // 注: growth_remix_job（旧「一键爆改」的任务表）已随该链路下线删除 —— 写入点早没了，
  // 只剩历史数据；现已没有代码引用。老库里那张表原样留着（不影响使用），新装库不再建。
  `CREATE TABLE IF NOT EXISTS growth_remix_output (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    variant TEXT NOT NULL DEFAULT 'A',
    title TEXT NOT NULL DEFAULT '',
    copy_text TEXT NOT NULL DEFAULT '',
    content_id INTEGER,
    compliance_json TEXT NOT NULL DEFAULT '{}',
    score REAL NOT NULL DEFAULT 0,
    status TEXT NOT NULL DEFAULT 'draft',
    created_at INTEGER NOT NULL
  )`,
  // 注: growth_publish_task / growth_publish_result（Phase 2「半自动发布」预留）已删除 ——
  // 除了这两段 DDL 与它们的索引，全仓从无一行代码读写过它们。发布回流走的是
  // growth_metric_snapshot（见 publisher/publishMetrics.ts），与这两张表无关。
  `CREATE TABLE IF NOT EXISTS growth_metric_snapshot (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    target_type TEXT NOT NULL DEFAULT 'content',
    target_id INTEGER NOT NULL,
    channel TEXT NOT NULL DEFAULT '',
    likes INTEGER NOT NULL DEFAULT 0,
    collects INTEGER NOT NULL DEFAULT 0,
    comments INTEGER NOT NULL DEFAULT 0,
    shares INTEGER NOT NULL DEFAULT 0,
    follows INTEGER NOT NULL DEFAULT 0,
    leads INTEGER NOT NULL DEFAULT 0,
    amount REAL NOT NULL DEFAULT 0,
    output_id INTEGER,
    captured_at INTEGER NOT NULL
  )`,
  // 营销 AI 工作台：任务
  `CREATE TABLE IF NOT EXISTS growth_ai_task (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    content_id INTEGER NOT NULL,
    store_id INTEGER,
    title TEXT NOT NULL DEFAULT '',
    goal TEXT NOT NULL DEFAULT 'image_text',
    status TEXT NOT NULL DEFAULT 'drafting',
    session_id INTEGER,
    summary TEXT NOT NULL DEFAULT '',
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    last_message_at INTEGER
  )`,
  `CREATE TABLE IF NOT EXISTS growth_output_asset (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    output_id INTEGER NOT NULL,
    asset_id INTEGER,
    role TEXT NOT NULL DEFAULT 'image',
    source TEXT NOT NULL DEFAULT '',
    prompt TEXT NOT NULL DEFAULT '',
    note TEXT NOT NULL DEFAULT '',
    created_at INTEGER NOT NULL
  )`,
  // 舆情监控：提及 / 评论
  `CREATE TABLE IF NOT EXISTS growth_buzz_mention (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    store_id INTEGER,
    platform TEXT NOT NULL DEFAULT '',
    kind TEXT NOT NULL DEFAULT '',
    url TEXT NOT NULL DEFAULT '',
    platform_item_id TEXT NOT NULL DEFAULT '',
    title TEXT NOT NULL DEFAULT '',
    content_text TEXT NOT NULL DEFAULT '',
    author_name TEXT NOT NULL DEFAULT '',
    author_id TEXT NOT NULL DEFAULT '',
    published_at INTEGER,
    interactions_json TEXT NOT NULL DEFAULT '{}',
    assets_json TEXT NOT NULL DEFAULT '[]',
    source TEXT NOT NULL DEFAULT 'manual',
    status TEXT NOT NULL DEFAULT 'new',
    sentiment TEXT NOT NULL DEFAULT '',
    score INTEGER NOT NULL DEFAULT 0,
    risk_level TEXT NOT NULL DEFAULT '',
    reasons_json TEXT NOT NULL DEFAULT '[]',
    diagnosis_json TEXT NOT NULL DEFAULT '{}',
    diagnosed_at INTEGER,
    note TEXT NOT NULL DEFAULT '',
    dedupe_key TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS growth_buzz_comment (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    mention_id INTEGER NOT NULL,
    author_name TEXT NOT NULL DEFAULT '',
    content TEXT NOT NULL DEFAULT '',
    likes INTEGER NOT NULL DEFAULT 0,
    is_high INTEGER NOT NULL DEFAULT 0,
    source TEXT NOT NULL DEFAULT 'manual',
    published_at INTEGER,
    created_at INTEGER NOT NULL
  )`
]

export const GROWTH_INDEXES: string[] = [
  `CREATE UNIQUE INDEX IF NOT EXISTS idx_growth_content_dedupe
    ON growth_content (dedupe_key) WHERE dedupe_key IS NOT NULL`,
  `CREATE INDEX IF NOT EXISTS idx_growth_content_created ON growth_content (created_at DESC)`,
  `CREATE INDEX IF NOT EXISTS idx_growth_asset_content ON growth_asset (content_id)`,
  `CREATE UNIQUE INDEX IF NOT EXISTS idx_growth_decomp_content ON growth_decomp (content_id)`,
  `CREATE INDEX IF NOT EXISTS idx_growth_metric_target
    ON growth_metric_snapshot (target_type, target_id, captured_at)`,
  `CREATE INDEX IF NOT EXISTS idx_growth_task_status ON growth_ai_task (status, updated_at DESC)`,
  `CREATE INDEX IF NOT EXISTS idx_growth_out_asset ON growth_output_asset (output_id)`,
  `CREATE UNIQUE INDEX IF NOT EXISTS idx_growth_buzz_dedupe
    ON growth_buzz_mention (dedupe_key) WHERE dedupe_key IS NOT NULL`,
  `CREATE INDEX IF NOT EXISTS idx_growth_buzz_status ON growth_buzz_mention (status, created_at DESC)`,
  `CREATE INDEX IF NOT EXISTS idx_growth_buzz_cmt ON growth_buzz_comment (mention_id, likes DESC)`
]
