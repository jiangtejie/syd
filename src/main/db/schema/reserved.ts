/**
 * 未接入的表（预留）与已下线表的清单。
 *
 * 这些表**不在启动时创建**：`RESERVED_TABLES` 是给未来功能备好的 DDL（用到了再从注释里
 * 搬进 `base.ts`），此前它们每次新建库都建出来、却没有任何代码读写，导致「库里有的表 ≠
 * 代码在用的表」，排查时先被误导一轮。`LEGACY_TABLES` 是历史上存在、功能已下线的表，
 * 由 `migrations.ts` 一次性清理。
 */

/** 预留表 DDL（当前不执行；接入功能时把对应语句移入 base.ts） */
export const RESERVED_TABLES: Record<string, string> = {
  // 客户档案：客户页当前由「会话 + 问题」派生，档案未接入
  customer: `CREATE TABLE customer (
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
  // 会话状态：支撑门控 G1/G3/G4 与转人工（当前门控全在内存/规则里算）
  session: `CREATE TABLE session (
    id TEXT PRIMARY KEY,
    wxid TEXT,
    status TEXT DEFAULT 'normal',
    last_msg_time INTEGER,
    auto_streak INTEGER DEFAULT 0,
    updated_at INTEGER
  )`,
  // 条件规则 P1~P4（P5~P8 为引擎内建 source 分支逻辑）
  tier_rule: `CREATE TABLE tier_rule (
    id INTEGER PRIMARY KEY,
    priority INTEGER,
    name TEXT,
    enabled INTEGER DEFAULT 1,
    condition_type TEXT,
    condition TEXT,
    action TEXT
  )`,
  // 知识库条目
  knowledge_item: `CREATE TABLE knowledge_item (
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
  // 回复候选与决策（含状态机）：建议状态当前随会话内存与 send_log 走
  reply_decision: `CREATE TABLE reply_decision (
    id INTEGER PRIMARY KEY,
    session_id TEXT,
    target_key TEXT,
    mode TEXT,
    source TEXT,
    status TEXT DEFAULT 'generated',
    suggestions TEXT,
    chosen TEXT,
    chosen_at INTEGER
  )`
}

/**
 * 已下线功能留下的表：老库里还在，新库不再创建。
 * `phrase_book`（话术库）此前每次启动都 DROP，现已并入一次性迁移统一处理。
 */
export const LEGACY_TABLES = [
  'phrase_book',
  'skill_package',
  'agent_memory',
  'ai_custom_tool',
  'ai_mcp_server'
] as const
