const Database = require('better-sqlite3-multiple-ciphers')
const path = require('path')
const db = new Database(path.join(process.env.APPDATA || '', 'wechat-cs-desktop', 'cs.db'), { readonly: true, fileMustExist: true })
const team = new Set(db.prepare('SELECT username FROM team_member').all().map((r) => r.username))
const ids = [82, 81, 60, 79, 78, 77]
const out = []
for (const id of ids) {
  const issue = db.prepare('SELECT id, title, occur_at, group_name, follow_up, last_reply_by FROM issue_feedback WHERE id = ?').get(id)
  if (!issue) continue
  const msgs = db.prepare('SELECT seq, msg_time, sender_name, sender_username, is_send, COALESCE(is_team,0) it, substr(text,1,34) t FROM issue_feedback_msg WHERE issue_id = ? ORDER BY seq').all(id)
  out.push({
    id,
    title: issue.title.slice(0, 28),
    occurAt: new Date(issue.occur_at).toLocaleString('zh-CN', { hour12: false }),
    group: issue.group_name,
    followUp: issue.follow_up,
    lastReplyBy: issue.last_reply_by,
    msgs: msgs.map((m) => ({
      t: new Date(m.msg_time).toLocaleString('zh-CN', { hour12: false }),
      who: m.is_send ? '我' : (m.sender_username && team.has(m.sender_username) ? '团队:' + (m.sender_name || m.sender_username) : (m.sender_name || m.sender_username || '?')),
      it: m.it,
      txt: m.t
    }))
  })
}
db.close()
console.log(JSON.stringify(out, null, 1))
