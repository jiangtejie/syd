/**
 * 客户档案（customer_profile）与标签（customer_tag）。
 *
 * 为什么表名不叫 `customer`：reserved.ts 里躺着一份**旧形状**的 customer DDL（id/wxid/tags/tier…），
 * 老库里可能存在这样一张表（迁移只在「空表」时才删）。沿用同名会撞上「CREATE TABLE IF NOT EXISTS
 * 不生效 → 列对不上 → 查询报 no such column」。换个名字就没有任何迁移风险，代价只是名字不同。
 *
 * 为什么必须有这张表：在此之前「客户档案」是**渲染端按会话实时派生**的（lib/customers.ts），
 * 意味着标签不可持久、不可编辑、不可被程序消费，来源/备注无处安放 —— 于是私域运营的两个杠杆
 * （分层触达、营销归因）都没有落点。
 */
export const CUSTOMER_TABLES: string[] = [
  `CREATE TABLE IF NOT EXISTS customer_profile (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    account_wxid TEXT NOT NULL,
    -- 稳定身份：会话/联系人的 username。备注与昵称会变，username 不会
    username TEXT NOT NULL,
    display_name TEXT NOT NULL DEFAULT '',
    remark TEXT NOT NULL DEFAULT '',
    nickname TEXT NOT NULL DEFAULT '',
    alias TEXT NOT NULL DEFAULT '',
    is_group INTEGER NOT NULL DEFAULT 0,
    -- 来源：营销归因用（内容/渠道/门店…）。系统推不出来，只能人工或按规则打
    source TEXT NOT NULL DEFAULT '',
    note TEXT NOT NULL DEFAULT '',
    first_seen_at INTEGER,
    last_active_at INTEGER,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    UNIQUE (account_wxid, username)
  )`,
  `CREATE TABLE IF NOT EXISTS customer_tag (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    account_wxid TEXT NOT NULL,
    username TEXT NOT NULL,
    tag TEXT NOT NULL,
    -- manual = 人工打的（资产）；derived = 规则算出来的（可由程序重算，清掉也不心疼）
    kind TEXT NOT NULL DEFAULT 'manual',
    created_at INTEGER NOT NULL,
    UNIQUE (account_wxid, username, tag)
  )`
]

export const CUSTOMER_INDEXES: string[] = [
  `CREATE INDEX IF NOT EXISTS idx_customer_profile_acct ON customer_profile (account_wxid, last_active_at DESC)`,
  `CREATE INDEX IF NOT EXISTS idx_customer_tag_acct ON customer_tag (account_wxid, username)`,
  `CREATE INDEX IF NOT EXISTS idx_customer_tag_pick ON customer_tag (account_wxid, tag)`
]
