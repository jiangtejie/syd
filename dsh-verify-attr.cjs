const Database = require('better-sqlite3-multiple-ciphers')
const path = require('path')
const db = new Database(path.join(process.env.APPDATA || '', 'wechat-cs-desktop', 'cs.db'), { readonly: true, fileMustExist: true })
const team = new Set(db.prepare('SELECT username FROM team_member').all().map((r) => r.username))
// 复刻新的归属算法，跑在 issue 82 的证据时间线上
function attribute(msgs) {
  const out = new Map(); let last = null
  for (const m of msgs) {
    if (m.is_send) { if (last) out.set(last, { at: m.msg_time }); continue }
    const u = m.sender_username
    if (!u) continue
    if (team.has(u)) { if (last) out.set(last, { at: m.msg_time, by: u }); continue }
    last = u
  }
  return out
}
function judge(id) {
  const issue = db.prepare('SELECT id, title, occur_at, follow_up, last_reply_by FROM issue_feedback WHERE id = ?').get(id)
  if (!issue) return null
  const msgs = db.prepare('SELECT msg_time, sender_username, is_send, COALESCE(is_team,0) it FROM issue_feedback_msg WHERE issue_id = ? ORDER BY msg_time').all(id)
  const reps = attribute(msgs)
  const anchorSender = msgs.find((m) => m.msg_time >= issue.occur_at - 2000 && !m.is_send)?.sender_username
  const hit = anchorSender ? reps.get(anchorSender) : null
  const ok = hit && hit.at >= issue.occur_at
  return { id, title: issue.title.slice(0, 22), 客户: anchorSender, 归属回复: hit ? new Date(hit.at).toLocaleString('zh-CN', { hour12: false }) + (hit.by ? ' by ' + hit.by : ' by 我') : null, 新判定: ok ? '跟进中' : '待处理', 库里现状态: issue.follow_up ? '跟进中' : '待处理' }
}
const rows = []
for (const id of [82, 81, 60, 79, 78, 77, 76]) { const r = judge(id); if (r) rows.push(r) }
// 企微群是否被后台跳过
const sess = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='session'").get()
const s = sess ? db.prepare("SELECT * FROM session LIMIT 1").all()[0] : null
db.close()
console.log(JSON.stringify({ 判定对比: rows, session表列: s ? Object.keys(s) : null }, null, 1))
