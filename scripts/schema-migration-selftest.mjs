/**
 * schema 迁移自检（真实库无关，全部在临时库里跑）。
 *
 * 为什么需要：migrate() 里最危险的是「一次性数据迁移」——它只在别人机器上跑一次，
 * 跑坏了就是数据丢失且没法重来。这里用**合成老库**（legacy 键 + 死表 + user_version=2）
 * 把四条迁移与幂等性都断言一遍，改动 schema 后先跑它再提交。
 *
 * 做法：schema.ts 是 TS 且相对导入没带扩展名，node 的 type-stripping 不能直接吃，
 * 所以先用 esbuild 打成 CJS（顺带证明主进程侧的代码可独立打包），再在临时库里执行。
 *
 * esbuild 已显式进 devDependencies：22 个自检脚本都 import 它，此前靠 vite/electron-vite 的
 * 传递依赖活着（升级即炸）。当时不敢声明是因为 npm/pnpm 两套锁文件并存、动锁会带出上千行
 * 无关变更；现在只保留 pnpm 一套锁，声明它只需 3 行 importer 变更。
 */
import Database from 'better-sqlite3-multiple-ciphers'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'
import { createRequire } from 'module'

const require = createRequire(import.meta.url)
// esbuild 只在打包这一步需要：拿不到就明确报错，别让后面的断言莫名其妙地失败
let buildSync
try {
  ;({ buildSync } = await import('esbuild'))
} catch {
  console.error('需要 esbuild（已在 devDependencies 声明）：请先 pnpm install')
  process.exit(1)
}
const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const work = mkdtempSync(join(tmpdir(), 'dsh-schema-selftest-'))

let failed = 0
const ok = (cond, label, extra = '') => {
  console.log((cond ? '  ✔ ' : '  ✖ ') + label + (extra ? ' — ' + extra : ''))
  if (!cond) failed++
}

let db = null
try {
  const bundle = join(work, 'schema.cjs')
  buildSync({
    entryPoints: [join(root, 'src/main/db/schema.ts')],
    bundle: true,
    platform: 'node',
    format: 'cjs',
    outfile: bundle,
    external: ['better-sqlite3-multiple-ciphers']
  })
  const { migrate, listTables } = require(bundle)

  const file = join(work, 'legacy.db')
  db = new Database(file)

  // ── 造一个「老库」：老形状 + legacy 键 + 死表 + 停在 user_version=2 ──
  db.exec(`CREATE TABLE app_config (key TEXT PRIMARY KEY, value TEXT)`)
  for (const t of ['phrase_book', 'skill_package', 'agent_memory', 'ai_custom_tool', 'ai_mcp_server']) {
    db.exec(`CREATE TABLE ${t} (id INTEGER PRIMARY KEY)`)
  }
  for (const t of ['customer', 'session', 'tier_rule', 'knowledge_item', 'reply_decision']) {
    db.exec(`CREATE TABLE ${t} (id INTEGER PRIMARY KEY)`)
  }
  const put = db.prepare('INSERT INTO app_config (key, value) VALUES (?, ?)')
  put.run(
    'issue.wm:wxid_a:111@chatroom',
    JSON.stringify({ at: 1000, msgTime: 2000, sortSeq: 3000 })
  )
  put.run(
    'issue.groupAt:wxid_a:111@chatroom',
    JSON.stringify({
      at: 1001,
      method: 'llm',
      count: 2,
      error: '',
      coverage: { msgs: 42, truncated: true }
    })
  )
  put.run('issue.wm:wxid_a:222@chatroom', '') // 旧代码用空值当删除
  put.run('issue.analyzed:wxid_a', JSON.stringify({ at: 1002, method: 'rule', count: 5, groups: 3, groupsTotal: 9, capped: true }))
  put.run('issue.analyzeFail:wxid_a', JSON.stringify({ at: 1003, error: '上次失败' }))
  put.run('ai.model', 'deepseek-chat') // 普通配置不该被动
  db.pragma('user_version = 2') // 历史版本留下的假版本号，迁移必须越过它
  // 真实老库（v2）形状：列比现在少，靠 ensureColumn 补齐
  db.exec(`CREATE TABLE issue_feedback (
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
  )`)
  db.exec(`CREATE TABLE issue_feedback_msg (
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
  )`)
  // 老库里的智能体：内置默认（播种时 id 写死 builtin-default）+ 一个用户自建的人设。
  // 迁移 6（产品改名）只许动前者，后者即便是同名也不许碰。
  db.exec(`CREATE TABLE ai_agent (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    description TEXT DEFAULT '',
    style TEXT DEFAULT 'warm',
    prompt TEXT DEFAULT '',
    created_at INTEGER,
    updated_at INTEGER
  )`)
  const putAgent = db.prepare('INSERT INTO ai_agent (id, name, created_at, updated_at) VALUES (?, ?, 1, 1)')
  putAgent.run('builtin-default', '微信私域智能客服')
  putAgent.run('mine', '微信私域智能客服')

  // 营销模块（2026-09 整体下线）的**老形状**，取自真实老库：一键爆改时代的 job_id
  // NOT NULL 无默认，当年每次生成标题/正文/配图都撞这个约束。
  // 留着它是为了验证迁移 8 —— 那种「跨了四个阶段、最多 16 张 growth_*」的库，
  // 正是它要按表名发现并整批删掉的输入。
  db.exec(`CREATE TABLE growth_remix_output (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    job_id INTEGER NOT NULL,
    variant TEXT NOT NULL DEFAULT 'A',
    title TEXT NOT NULL DEFAULT '',
    copy_text TEXT NOT NULL DEFAULT '',
    content_id INTEGER,
    compliance_json TEXT NOT NULL DEFAULT '{}',
    score REAL NOT NULL DEFAULT 0,
    status TEXT NOT NULL DEFAULT 'draft',
    created_at INTEGER NOT NULL
  )`)
  db.exec('CREATE INDEX idx_growth_remix_out_job ON growth_remix_output (job_id)')
  db.exec(
    "INSERT INTO growth_remix_output (id, job_id, variant, title, copy_text, content_id, status, created_at)" +
      " VALUES (7, 3, 'A', '老产出标题', '老产出正文', 11, 'selected', 1700000000000)"
  )
  // 同一次演进：代码不再写 updated_at，老库里它还是 NOT NULL 无默认 → 任何「把图挂到产出上」都失败
  db.exec(`CREATE TABLE growth_output_asset (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    output_id INTEGER NOT NULL,
    asset_id INTEGER,
    role TEXT NOT NULL DEFAULT 'image',
    source TEXT NOT NULL DEFAULT '',
    prompt TEXT NOT NULL DEFAULT '',
    note TEXT NOT NULL DEFAULT '',
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  )`)
  db.exec(
    "INSERT INTO growth_output_asset (id, output_id, asset_id, role, created_at, updated_at)" +
      " VALUES (5, 7, 42, 'cover', 1700000000001, 1700000000001)"
  )
  // 营销模块写过的配置：生图通道与月度上限、门店启用开关、两条已下线链路的键
  put.run('growth.image.apiKey', 'sk-legacy-image')
  put.run('growth.image.monthlyLimit', '80')
  put.run('growth.enabled', 'true')
  put.run('growth.search.apiKey', 'legacy-search')

  // 营销 AI 工作台的会话：建任务时 setChatScope(sessionId, 'growth') 打的标记。
  // 会话列表（chatRepo.listSessions）按 wxid 取全部、不按 scope 过滤 —— 所以它必须被迁移 8
  // 清掉，否则客服工作台会列出一串点开即报错的死会话。
  db.exec(`CREATE TABLE chat_session (
    id INTEGER PRIMARY KEY,
    wxid TEXT DEFAULT '',
    title TEXT NOT NULL,
    agent_id TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    scope TEXT NOT NULL DEFAULT ''
  )`)
  db.exec(`CREATE TABLE chat_message (
    id INTEGER PRIMARY KEY,
    session_id INTEGER NOT NULL,
    role TEXT NOT NULL,
    content TEXT NOT NULL DEFAULT '',
    created_at INTEGER NOT NULL
  )`)
  db.exec("INSERT INTO chat_session (id, wxid, title, created_at, updated_at, scope) VALUES (1, 'wxid_a', '爆改：老素材', 1, 1, 'growth')")
  db.exec("INSERT INTO chat_session (id, wxid, title, created_at, updated_at, scope) VALUES (2, 'wxid_a', '客服会话', 1, 1, '')")
  db.exec("INSERT INTO chat_message (id, session_id, role, content, created_at) VALUES (1, 1, 'user', '营销会话的消息', 1)")
  db.exec("INSERT INTO chat_message (id, session_id, role, content, created_at) VALUES (2, 2, 'user', '客服会话的消息', 1)")
  db.exec(`INSERT INTO issue_feedback (id, key, wxid, group_username, status) VALUES (1, 'k1', 'wxid_a', '111@chatroom', 'open')`)
  // 故意留 2 条重复证据：迁移要去重并建唯一索引
  const putMsg = db.prepare('INSERT INTO issue_feedback_msg (id, issue_id, seq) VALUES (?, ?, ?)')
  putMsg.run(1, 1, 100)
  putMsg.run(2, 1, 100)
  putMsg.run(3, 1, 101)

  const res = migrate(db)
  console.log('迁移结果:', JSON.stringify(res))

  console.log('\n一次性迁移:')
  ok(res.applied.length === 6, '六条数据迁移都跑了（未被老版本号 2 跳过）', res.applied.join(', '))
  ok(
    res.columnsAdded.includes('issue_feedback.assignee') && res.columnsAdded.includes('issue_feedback_msg.is_team'),
    '老库缺列被补齐',
    res.columnsAdded.length + ' 列'
  )
  ok(res.from === 2 && res.to === 8, '版本号从 2 对齐到最新', res.from + ' → ' + res.to)

  console.log('\n产品改名（迁移 6）：')
  const agentName = (id) => db.prepare('SELECT name FROM ai_agent WHERE id = ?').get(id)?.name
  ok(agentName('builtin-default') === '私域运营助手', '内置默认智能体改成新名', agentName('builtin-default'))
  ok(
    agentName('mine') === '微信私域智能客服',
    '★ 只按 id 认内置默认：用户自建的人设即便同名也不动',
    agentName('mine')
  )

  console.log('\n状态搬迁:')
  const wm = db
    .prepare("SELECT * FROM issue_group_state WHERE account_wxid='wxid_a' AND group_username='111@chatroom'")
    .get()
  ok(!!wm && wm.wm_msg_time === 2000 && wm.wm_sort_seq === 3000 && wm.last_at === 1001, '水位与节流戳同群合并到一行', JSON.stringify(wm))
  ok(wm?.last_method === 'llm' && wm?.last_count === 2 && wm?.coverage_msgs === 42 && wm?.coverage_truncated === 1, '分析结果与覆盖度逐字段搬对')
  ok(!db.prepare("SELECT 1 FROM issue_group_state WHERE group_username='222@chatroom'").get(), '空值键不产生状态行')
  const acc = db.prepare("SELECT * FROM issue_account_state WHERE account_wxid='wxid_a'").get()
  ok(!!acc && acc.last_at === 1002 && acc.last_count === 5 && acc.groups_hint === undefined && acc.last_groups === 3 && acc.last_groups_total === 9 && acc.last_capped === 1 && acc.fail_at === 1003 && acc.fail_error === '上次失败', '账号级状态与失败标记搬对', JSON.stringify(acc))
  ok(db.prepare("SELECT COUNT(*) c FROM app_config WHERE key LIKE 'issue.%'").get().c === 0, 'issue.* 状态键已清空')
  ok(db.prepare("SELECT value FROM app_config WHERE key='ai.model'").get()?.value === 'deepseek-chat', '普通配置未被动')

  console.log('\n死表与索引:')
  const tables = listTables(db)
  for (const t of ['phrase_book', 'skill_package', 'agent_memory', 'ai_custom_tool', 'ai_mcp_server']) {
    ok(!tables.includes(t), t + ' 已移除')
  }
  /**
   * ★ 业务表**不许**再被迁移删掉。
   *
   * 这条迁移原本还会把「预留且为空」的业务表一并 DROP（customer/session/…）。看着无害，
   * 但它每次新装库都会跑一次 —— 于是「客户表」在任何一台新机器上都被建出来又删掉，
   * 客户资产永远是零（B1 的根因）。现在只有真正下线的表才清。
   */
  for (const t of ['customer', 'session', 'tier_rule', 'knowledge_item', 'reply_decision']) {
    ok(tables.includes(t), t + ' 不再被迁移删除（老库里仍在）')
  }
  ok(tables.includes('customer_profile'), '★ 客户档案表已由基座 DDL 建出')
  ok(tables.includes('customer_tag'), '★ 客户标签表已由基座 DDL 建出')
  const idx = db.prepare("SELECT name FROM sqlite_master WHERE type='index' AND sql IS NOT NULL").all().map((r) => r.name)
  for (const ix of ['idx_im_audit_created', 'idx_feishu_send_log_created', 'idx_send_log_created', 'idx_issue_fb_msg_uniq', 'idx_issue_group_state_last']) {
    ok(idx.includes(ix), ix)
  }
  ok(db.prepare('SELECT COUNT(*) c FROM issue_feedback_msg').get().c === 2, '重复证据行被去重（3 → 2）')

  console.log('\n营销模块整表下线（迁移 8）:')
  const after = listTables(db)
  ok(
    after.every((t) => !t.startsWith('growth_')),
    '★ growth_* 表全部删除（现役 10 张 + 四条已下线链路遗留的，一律按表名发现）',
    after.filter((t) => t.startsWith('growth_')).join(',') || '无残留'
  )
  ok(
    !db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'index' AND name GLOB 'idx_growth_*'").get(),
    '★ growth 的索引一并清掉'
  )
  ok(
    db.prepare("SELECT COUNT(*) c FROM app_config WHERE key LIKE 'growth.%'").get().c === 0,
    '★ 营销的配置键已清空（生图通道 / 月度上限 / 门店开关 / 两条已下线链路）'
  )
  ok(
    db.prepare("SELECT value FROM app_config WHERE key = 'ai.model'").get()?.value === 'deepseek-chat',
    '非营销配置未被动'
  )
  // 删表前落了快照：素材记录与产出正文不可再生，这是唯一的退路
  const snapFile = join(work, 'growth-purge-v8.json')
  ok(existsSync(snapFile), '★ 删表前落了 JSON 快照（growth-purge-v8.json）')
  ok(
    !db.prepare("SELECT 1 FROM chat_session WHERE scope = 'growth'").get(),
    '★ 营销 AI 工作台的会话已清（会话列表不按 scope 过滤，留着就是死会话）'
  )
  ok(
    !db.prepare('SELECT 1 FROM chat_message WHERE session_id = 1').get(),
    '★ 营销会话的消息一并清掉（不依赖 foreign_keys 级联）'
  )
  ok(!!db.prepare('SELECT 1 FROM chat_session WHERE id = 2').get(), '客服会话不受影响')
  ok(!!db.prepare('SELECT 1 FROM chat_message WHERE session_id = 2').get(), '客服会话的消息保留')
  if (existsSync(snapFile)) {
    const snap = JSON.parse(readFileSync(snapFile, 'utf8'))
    ok(
      Array.isArray(snap.growth_remix_output) &&
        snap.growth_remix_output.some((r) => r.title === '老产出标题'),
      '★ 快照里留着老产出的正文（真删错了还能捞回来）'
    )
    ok(
      Array.isArray(snap.growth_output_asset) && snap.growth_output_asset.length === 1,
      '★ 快照覆盖到每一张被删的表（不只产出一张）'
    )
  }

  console.log('\n幂等:')
  const res2 = migrate(db)
  ok(res2.applied.length === 0, '二次 migrate 不重复执行数据迁移')
  ok(db.prepare('SELECT COUNT(*) c FROM issue_group_state').get().c === 1, '二次 migrate 状态行数不变')

  console.log('\n约束:')
  let dup = false
  try {
    db.exec('INSERT INTO issue_feedback_msg (id, issue_id, seq) VALUES (99, 1, 100)')
    dup = true
  } catch {
    dup = false
  }
  ok(!dup, '唯一索引拦住重复证据写入')
} finally {
  try {
    db?.close()
  } catch {
    /* ignore */
  }
  // Windows 上刚关闭的库文件偶尔仍被占用：清理失败不该让自检报错
  try {
    rmSync(work, { recursive: true, force: true })
  } catch {
    /* ignore */
  }
}

console.log(failed === 0 ? '\n全部通过 ✅' : '\n' + failed + ' 项失败 ❌')
process.exit(failed === 0 ? 0 : 1)
