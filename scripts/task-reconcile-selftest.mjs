import Database from 'better-sqlite3-multiple-ciphers'
import { buildSync } from 'esbuild'
import { createRequire } from 'module'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { dirname, join } from 'path'
import { fileURLToPath } from 'url'

/**
 * 启动对账自检（临时真库，不碰用户数据）。
 *
 * 钉住的事实：断电 / 杀进程 / 升级重启后，停在 running 的任务行不会被任何东西收尾，
 * 界面一直显示「运行中」，运营以为通道还在跑。这里断言：
 *   ① 上一进程遗留的 running 行被改判 interrupted；
 *   ② **本进程自己新起**的 running 行不许被动（否则正在跑的任务会被误判中断）；
 *   ③ 终态行（done/ok/failed）一律不动。
 */

const require = createRequire(import.meta.url)
const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const work = mkdtempSync(join(tmpdir(), 'dsh-reconcile-'))

let failed = 0
const ok = (cond, label, extra = '') => {
  console.log((cond ? '  ✔ ' : '  ✖ ') + label + (extra ? ' — ' + extra : ''))
  if (!cond) failed++
}

let db = null
try {
  const bundle = join(work, 'reconcile.cjs')
  buildSync({
    entryPoints: [join(root, 'src/main/db/reconcile.ts')],
    bundle: true,
    platform: 'node',
    format: 'cjs',
    outfile: bundle,
    external: ['better-sqlite3-multiple-ciphers']
  })
  const { reconcileInterruptedTasks, INTERRUPTED } = require(bundle)

  db = new Database(join(work, 'reconcile.db'))
  db.exec('CREATE TABLE im_audit (id INTEGER PRIMARY KEY, status TEXT, error TEXT, created_at INTEGER, finished_at INTEGER)')
  db.exec('CREATE TABLE report_run (id INTEGER PRIMARY KEY, status TEXT, errors TEXT, started_at INTEGER, ended_at INTEGER)')
  db.exec('CREATE TABLE growth_crawl_task (id INTEGER PRIMARY KEY, status TEXT, error TEXT, started_at INTEGER, ended_at INTEGER)')

  const started = 1_000_000
  const old = started - 60_000
  const fresh = started + 60_000
  // 三张表的「原因列 / 起始时间列」名字各不相同（error/errors、created_at/started_at），
  // 这里按真实 DDL 插，别用一个通用 helper 糊过去 —— 糊过去就测不出列名写错。
  const insAudit = db.prepare('INSERT INTO im_audit (status, error, created_at) VALUES (?, NULL, ?)')
  const insRun = db.prepare('INSERT INTO report_run (status, errors, started_at) VALUES (?, NULL, ?)')
  const insCrawl = db.prepare('INSERT INTO growth_crawl_task (status, error, started_at) VALUES (?, NULL, ?)')

  insAudit.run('running', old)
  insAudit.run('queued', old)
  insAudit.run('done', old)
  insAudit.run('running', fresh)
  insRun.run('running', old)
  insRun.run('ok', old)
  insRun.run('running', fresh)
  insCrawl.run('running', old)
  insCrawl.run('error', old)

  const r = reconcileInterruptedTasks(db, started)
  const statusOf = (t, ats, st) =>
    db.prepare('SELECT COUNT(*) AS n FROM ' + t + ' WHERE status = ?').get(st).n

  console.log('改判范围：')
  ok(r.imAudit === 2, 'im_audit：遗留 running+queued 被改判（2 条）', 'got ' + r.imAudit)
  ok(r.reportRun === 1, 'report_run：只改遗留 running（1 条）', 'got ' + r.reportRun)
  ok(r.growthCrawl === 1, 'growth_crawl_task：只改遗留 running（1 条）', 'got ' + r.growthCrawl)

  console.log('不许误伤：')
  const myRun = db.prepare('SELECT COUNT(*) AS n FROM im_audit WHERE created_at = ? AND status = ?').get(fresh, 'running').n
  ok(myRun === 1, '本进程新起的 running 行保持不动', 'got ' + myRun)
  const rrFresh = db.prepare('SELECT COUNT(*) AS n FROM report_run WHERE started_at = ? AND status = ?').get(fresh, 'running').n
  ok(rrFresh === 1, '本进程新起的上报运行保持不动', 'got ' + rrFresh)
  ok(statusOf('im_audit', null, 'done') === 1, '终态 done 不动')
  ok(statusOf('report_run', null, 'ok') === 1, '终态 ok 不动')
  ok(statusOf('growth_crawl_task', null, 'error') === 1, '终态 error 不动')

  console.log('改判内容：')
  ok(statusOf('im_audit', null, INTERRUPTED) === 2, '状态写成 interrupted')
  const note = db.prepare('SELECT error FROM im_audit WHERE status = ? LIMIT 1').get(INTERRUPTED)
  ok(!!note && !!note.error, '补了可读原因（不留空 error）', note ? String(note.error).slice(0, 20) : 'null')
  const fin = db.prepare('SELECT finished_at FROM im_audit WHERE status = ? LIMIT 1').get(INTERRUPTED)
  ok(!!fin && typeof fin.finished_at === 'number' && fin.finished_at > 0, '补了 finished_at')

  console.log('幂等：')
  const again = reconcileInterruptedTasks(db, started)
  ok(again.imAudit === 0 && again.reportRun === 0 && again.growthCrawl === 0, '再跑一轮不再改任何行（幂等）')
} finally {
  try {
    if (db) db.close()
  } catch {
    /* ignore */
  }
  try {
    rmSync(work, { recursive: true, force: true })
  } catch {
    /* Windows 偶发占用 */
  }
}

console.log(failed === 0 ? '\n全部通过 ✅' : '\n' + failed + ' 项失败 ❌')
process.exit(failed === 0 ? 0 : 1)
