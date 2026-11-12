import { build, buildSync } from 'esbuild'
import Database from 'better-sqlite3-multiple-ciphers'
import { createRequire } from 'module'
import { mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { dirname, join } from 'path'
import { fileURLToPath } from 'url'

/**
 * 长会话摘要水位持久化自检（真 SQL，跑在临时库上，不碰真实 cs.db）。
 *
 * 钉住的是「摘要落库带水位」这条新契约里最容易静默坏掉的三处：
 *  ① 老库补列后 summary / summary_upto_id 真的存在且默认值正确（否则读出来是 undefined，
 *     水位恒为 0 → 每轮重新摘要，成本优化静默失效）；
 *  ② 水位单调推进后，已摘要的行不再进上下文（靠 chat_message.id 升序）；
 *  ③ **清空会话必须把摘要与水位一起清** —— 只删消息不清摘要，模型会「记得」已删掉的对话。
 *
 * chatRepo 用 getDb() 单例（依赖 electron），所以打包时把 '../database' 换成注入临时库的桩。
 */

const require = createRequire(import.meta.url)
const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const work = mkdtempSync(join(tmpdir(), 'dsh-chat-summary-'))

let failed = 0
const ok = (cond, label, extra = '') => {
  console.log((cond ? '  ✔ ' : '  ✖ ') + label + (extra ? ' — ' + extra : ''))
  if (!cond) failed++
}

let db = null
try {
  // 先建库并跑迁移（与 schema 自检同一套真实 DDL + 补列路径）
  const schemaBundle = join(work, 'schema.cjs')
  buildSync({
    entryPoints: [join(root, 'src/main/db/schema.ts')],
    bundle: true,
    platform: 'node',
    format: 'cjs',
    outfile: schemaBundle,
    external: ['better-sqlite3-multiple-ciphers']
  })
  const { migrate } = require(schemaBundle)
  db = new Database(join(work, 'cs.db'))
  db.pragma('foreign_keys = ON')
  migrate(db)

  console.log('补列形状（老库升级路径）：')
  const cols = db.prepare(`PRAGMA table_info(chat_session)`).all()
  const byName = Object.fromEntries(cols.map((c) => [c.name, c]))
  ok(!!byName.summary, 'chat_session.summary 存在')
  ok(!!byName.summary_upto_id, 'chat_session.summary_upto_id 存在')
  ok(byName.summary_upto_id?.notnull === 1, '水位列 NOT NULL（读出 undefined 会让优化静默失效）')
  ok(
    String(byName.summary_upto_id?.dflt_value) === '0',
    '水位默认 0',
    `实得 ${byName.summary_upto_id?.dflt_value}`
  )

  // 把 chatRepo 的数据库单例换成这个临时库
  const stub = join(work, 'db-stub.cjs')
  writeFileSync(stub, `module.exports = { getDb: () => globalThis.__TEST_DB__ }\n`)
  const repoBundle = join(work, 'chatRepo.cjs')
  // 插件只在异步 API 可用（esbuild 限制），所以这一步用 await build
  await build({
    entryPoints: [join(root, 'src/main/db/repos/chatRepo.ts')],
    bundle: true,
    platform: 'node',
    format: 'cjs',
    outfile: repoBundle,
    external: ['better-sqlite3-multiple-ciphers'],
    plugins: [
      {
        name: 'inject-temp-db',
        setup(b) {
          b.onResolve({ filter: /^\.\.\/database$/ }, () => ({ path: stub }))
        }
      }
    ]
  })
  globalThis.__TEST_DB__ = db
  const {
    createChat,
    appendChatMessage,
    listChatMessages,
    clearChatMessages,
    getChatSummary,
    setChatSummary
  } = require(repoBundle)

  const sid = createChat('wxid_test', '摘要水位自检')

  console.log('默认值与往返：')
  {
    const s = getChatSummary(sid)
    ok(s.summary === null && s.uptoId === 0, '新会话无摘要、水位 0', JSON.stringify(s))
    setChatSummary(sid, '早期结论摘要', 42)
    const r = getChatSummary(sid)
    ok(r.summary === '早期结论摘要' && r.uptoId === 42, '摘要与水位往返一致', JSON.stringify(r))
    setChatSummary(sid, '  ', 7)
    ok(getChatSummary(sid).summary === null, '空白摘要归一为 null（不当成有摘要）')
    setChatSummary(sid, null, -5)
    ok(getChatSummary(sid).uptoId === 0, '负水位落库收敛为 0')
    setChatSummary(sid, null, 12.9)
    ok(getChatSummary(sid).uptoId === 12, '水位取整（id 是整数）')
    ok(getChatSummary(999999).uptoId === 0, '不存在的会话安全返回 0')
  }

  console.log('消息 id 升序（水位判据的前提）：')
  setChatSummary(sid, '旧段摘要', 0)
  const ids = []
  for (let i = 0; i < 30; i++) {
    ids.push(appendChatMessage(sid, i % 2 ? 'assistant' : 'user', 'text', `第${i}条`))
  }
  ok(
    ids.every((v, i) => i === 0 || v > ids[i - 1]),
    'appendChatMessage 返回的 id 严格递增'
  )
  const listed = listChatMessages(sid)
  ok(
    listed.every((m, i) => i === 0 || m.id > listed[i - 1].id),
    'listChatMessages 按 id 升序'
  )
  {
    // 水位设在中间：只有水位之后的行该进上下文
    const upto = ids[9]
    setChatSummary(sid, '前十条的摘要', upto)
    const fresh = listChatMessages(sid).filter((m) => m.id > getChatSummary(sid).uptoId)
    ok(fresh.length === 20, '水位之后的行数正确', `实得 ${fresh.length}`)
    ok(fresh[0].content === '第10条', '水位边界不含已摘要的那一条')
  }

  console.log('★ 清空会话必须连摘要与水位一起清：')
  {
    setChatSummary(sid, '不该活下来的摘要', ids[20])
    ok(getChatSummary(sid).summary !== null, '清空前确有摘要')
    clearChatMessages(sid)
    const after = getChatSummary(sid)
    ok(listChatMessages(sid).length === 0, '消息已清空')
    ok(after.summary === null, '摘要一并清空（否则模型会「记得」已删掉的对话）')
    ok(after.uptoId === 0, '水位归零（否则新消息 id 若小于旧水位会被整批跳过）')
    // 清空后重新写入：新行必须能进上下文
    const nid = appendChatMessage(sid, 'user', 'text', '清空后的新消息')
    const fresh = listChatMessages(sid).filter((m) => m.id > getChatSummary(sid).uptoId)
    ok(fresh.length === 1 && fresh[0].id === nid, '清空后的新消息不被旧水位吞掉')
  }

  console.log('compact 标记行落库：')
  {
    const cid = appendChatMessage(sid, 'assistant', 'compact', '旧对话已压缩')
    const row = listChatMessages(sid).find((m) => m.id === cid)
    ok(row?.kind === 'compact', 'compact 行按原 kind 读回（渲染端据此展示标记）')
    const last = db
      .prepare(
        `SELECT content FROM chat_message WHERE session_id=? AND role='assistant' AND kind='text' ORDER BY id DESC LIMIT 1`
      )
      .get(sid)
    ok(last === undefined, 'compact 不会被 IM 回复通道当成助手正文发出去')
  }
} catch (e) {
  console.error('自检异常：', e)
  failed++
} finally {
  try {
    db?.close()
  } catch {
    /* ignore */
  }
  try {
    rmSync(work, { recursive: true, force: true })
  } catch {
    /* ignore */
  }
}

console.log(failed === 0 ? '\n全部通过' : `\n${failed} 条失败`)
process.exit(failed === 0 ? 0 : 1)
