/**
 * 上报链路的 PG 冒烟(需要真实 PostgreSQL，**不进 test:all**)：
 *   PGHOST=127.0.0.1 PGPORT=5433 PGUSER=root PGPASSWORD=... PGDATABASE=goclaw_test \
 *     node --experimental-strip-types scripts/report-voice-pg-smoke.mjs
 *
 * 为什么要有它：语音落库这条链路的 SQL(补列 / 15 列 upsert / 回写)在离线自检里验不了 ——
 * 参数个数、COALESCE 语义、WHERE 守卫都只有真库能证。全程在事务里跑并 ROLLBACK，不动真实数据。
 * 未配置 PGHOST 时直接跳过（退出码 0），保证谁都能无脑跑。
 */
import { Client } from 'pg'
import { ensurePgSchema, upsertPgMessages, updatePgVoice } from '../src/main/services/report/pgWriter.ts'

if (!process.env.PGHOST) {
  console.log('跳过：未配置 PGHOST（PG 冒烟需要真实数据库）')
  process.exit(0)
}
const client = new Client({
  host: process.env.PGHOST,
  port: Number(process.env.PGPORT) || 5432,
  database: process.env.PGDATABASE || 'postgres',
  user: process.env.PGUSER || 'postgres',
  password: process.env.PGPASSWORD || '',
  connectionTimeoutMillis: 8000
})
const out = []
const log = (ok, name, detail) => { out.push(`${ok ? '  ok  ' : ' FAIL '} ${name}${detail ? ' — ' + detail : ''}`); return ok }

await client.connect()
await client.query('BEGIN') // 全程在事务里跑，最后 ROLLBACK：不动真实数据
try {
  await ensurePgSchema(client, 'chat')
  const cols = (await client.query(
    "SELECT column_name FROM information_schema.columns WHERE table_schema='chat' AND table_name='messages' ORDER BY ordinal_position"
  )).rows.map((r) => r.column_name)
  log(cols.includes('voice_text'), 'ensurePgSchema 给已有表补出 voice_text', cols.join(','))
  log(cols.includes('voice_duration_ms'), 'ensurePgSchema 补出 voice_duration_ms')

  const S = '44985433530@chatroom' // 真实存在的会话（FK 约束），行号用 990xxx 且最后回滚
  const base = { formattedTime: '2026-09-16 14:24:00', isSend: 0, senderUsername: null, senderDisplayName: null, groupNickname: null, replyToMessageId: null, mediaMd5: null, mediaPath: null }
  await client.query(`DELETE FROM chat.messages WHERE session_wxid = '${S}'`)

  // ① 新语音：本轮已转写（落库就带文本）
  await upsertPgMessages(client, 'chat', [
    { ...base, sessionWxid: S, localId: 990001, createTime: 1789538700, msgType: '语音消息', content: '[语音] 8″ 好，我们看一下', voiceText: '好，我们看一下', voiceDurationMs: 8000 },
    { ...base, sessionWxid: S, localId: 990002, createTime: 1789538701, msgType: '语音消息', content: '[语音]', voiceText: null, voiceDurationMs: 5000 },
    { ...base, sessionWxid: S, localId: 990003, createTime: 1789538702, msgType: '文本消息', content: '你好', voiceText: null, voiceDurationMs: null }
  ])
  const r1 = (await client.query(`SELECT local_id, content, voice_text, voice_duration_ms FROM chat.messages WHERE session_wxid='${S}' ORDER BY local_id`)).rows
  log(r1[0].content === '[语音] 8″ 好，我们看一下' && r1[0].voice_text === '好，我们看一下' && r1[0].voice_duration_ms === 8000, '① 已转写语音：content/voice_text/时长都落库', JSON.stringify(r1[0]))
  log(r1[1].content === '[语音]' && r1[1].voice_text === null && r1[1].voice_duration_ms === 5000, '② 未转写语音：占位 + 时长，文本为空', JSON.stringify(r1[1]))
  log(r1[2].voice_text === null && r1[2].voice_duration_ms === null, '③ 文本行语音列全空', JSON.stringify(r1[2]))

  // ② 转写完成后回写（走 updatePgVoice：只补没有文本的行）
  const n1 = await updatePgVoice(client, 'chat', [{ sessionWxid: S, localId: 990002, content: '[语音] 5″ 这个现在有人收这个货吗', voiceText: '这个现在有人收这个货吗', voiceDurationMs: 5000 }])
  const r2 = (await client.query(`SELECT content, voice_text, voice_duration_ms FROM chat.messages WHERE session_wxid='${S}' AND local_id=990002`)).rows[0]
  log(n1 === 1, 'updatePgVoice 命中 1 行', String(n1))
  log(r2.content === '[语音] 5″ 这个现在有人收这个货吗' && r2.voice_text === '这个现在有人收这个货吗', '回写后 content 与 voice_text 都变', JSON.stringify(r2))

  // ③ 幂等/不覆盖：重复回写同一行不会动（content 已不是占位、voice_text 已有）
  const n2 = await updatePgVoice(client, 'chat', [{ sessionWxid: S, localId: 990002, content: '[语音] 99″ 覆盖测试', voiceText: '覆盖测试', voiceDurationMs: 99000 }])
  const r3 = (await client.query(`SELECT content, voice_text FROM chat.messages WHERE session_wxid='${S}' AND local_id=990002`)).rows[0]
  log(n2 === 0 && r3.voice_text === '这个现在有人收这个货吗', '重复回写不影响已有文本（WHERE 守住）', JSON.stringify(r3))

  // ④ 再次 upsert 同一条（模拟下一轮重新扫到）：voice_text 用 COALESCE 不丢
  await upsertPgMessages(client, 'chat', [
    { ...base, sessionWxid: S, localId: 2, createTime: 1789538701, msgType: '语音消息', content: '[语音]', voiceText: null, voiceDurationMs: 5000 }
  ])
  const r4 = (await client.query(`SELECT content, voice_text, voice_duration_ms FROM chat.messages WHERE session_wxid='${S}' AND local_id=990002`)).rows[0]
  log(r4.voice_text === '这个现在有人收这个货吗', '重扫同一行不会把 voice_text 冲掉（COALESCE）', JSON.stringify(r4))
  log(r4.voice_duration_ms === 5000, '时长同样保住')

  // ⑤ 历史补写用的那条 SELECT（与 chatSyncRunner.selectVoiceRowsMissingText 同一形状）语法/计划可用
  const hist = (await client.query(
    `SELECT session_wxid, local_id, create_time FROM chat.messages
      WHERE msg_type = '语音消息' AND (voice_text IS NULL OR voice_text = '')
      ORDER BY create_time DESC LIMIT $1`,
    [5]
  )).rows
  log(Array.isArray(hist), '历史待补语音的查询可执行', `命中 ${hist.length} 行`)
} finally {
  await client.query('ROLLBACK')
  await client.end().catch(() => undefined)
}
console.log(out.join('\n'))
const failed = out.filter((l) => l.startsWith(' FAIL')).length
console.log(failed === 0 ? '\n全部通过 ✅（事务已回滚，未改动真实数据）' : `\n${failed} 项未通过 ❌`)
process.exit(failed === 0 ? 0 : 1)