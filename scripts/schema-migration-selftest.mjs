/**
 * schema 迁移自检（真实库无关，全部在临时库里跑）。
 *
 * 为什么需要：migrate() 里最危险的是「一次性数据迁移」——它只在别人机器上跑一次，
 * 跑坏了就是数据丢失且没法重来。这里用**合成老库**（legacy 键 + 死表 + user_version=2）
 * 把三条迁移与幂等性都断言一遍，改动 schema 后先跑它再提交。
 *
 * 做法：schema.ts 是 TS 且相对导入没带扩展名，node 的 type-stripping 不能直接吃，
 * 所以先用 esbuild 打成 CJS（顺带证明主进程侧的代码可独立打包），再在临时库里执行。
 *
 * esbuild 不写进 package.json：它是 vite 的传递依赖，本仓库 npm/pnpm 两套锁文件都在，
 * 为一个自检脚本动锁会带出上千行无关变更（实测 npm 顺带裁掉了 760 行历史依赖）。
 */
import Database from 'better-sqlite3-multiple-ciphers'
import { mkdtempSync, rmSync } from 'fs'
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
  console.error('需要 esbuild（vite 的传递依赖）：请先 npm install / pnpm install')
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
  db.exec(`INSERT INTO issue_feedback (id, key, wxid, group_username, status) VALUES (1, 'k1', 'wxid_a', '111@chatroom', 'open')`)
  // 故意留 2 条重复证据：迁移要去重并建唯一索引
  const putMsg = db.prepare('INSERT INTO issue_feedback_msg (id, issue_id, seq) VALUES (?, ?, ?)')
  putMsg.run(1, 1, 100)
  putMsg.run(2, 1, 100)
  putMsg.run(3, 1, 101)

  const res = migrate(db)
  console.log('迁移结果:', JSON.stringify(res))

  console.log('\n一次性迁移:')
  ok(res.applied.length === 3, '三条数据迁移都跑了（未被老版本号 2 跳过）', res.applied.join(', '))
  ok(
    res.columnsAdded.includes('issue_feedback.assignee') && res.columnsAdded.includes('issue_feedback_msg.is_team'),
    '老库缺列被补齐',
    res.columnsAdded.length + ' 列'
  )
  ok(res.from === 2 && res.to === 3 + 2, '版本号从 2 对齐到最新', res.from + ' → ' + res.to)

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
