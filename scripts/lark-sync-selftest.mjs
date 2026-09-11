#!/usr/bin/env node
/**
 * 飞书 Base 同步的字段映射自检（纯函数，零依赖、不联网、不碰库）：
 *   node --experimental-strip-types scripts/lark-sync-selftest.mjs
 *
 * 为什么单独立一套：映射错一个值就是「同事在手机上点了已解决，本地没变」这类**无声故障**，
 * 而且只会在真实协作里暴露。这里把状态往返、跟进人匹配、脱敏与冲突比对全部钉死。
 */
import {
  assigneeFromText,
  collabOf,
  diffCollab,
  hashOf,
  issueToFields,
  statusFromText,
  statusText
} from '../src/main/services/lark/baseMapping.ts'

let failed = 0
const log = (ok, name, detail) => {
  if (!ok) failed++
  console.log(`${ok ? '  ok  ' : ' FAIL '} ${name}${detail ? ' — ' + detail : ''}`)
}

console.log('\n[1] Base 状态文案 → 本地状态（同事在表格里选的值）')
for (const [text, want] of [
  ['待处理', 'open'],
  ['跟进中', 'open'],
  ['已解决', 'done'],
  ['已搁置', 'stalled'],
  ['不是问题', 'archived'],
  ['已归档', 'archived']
]) {
  log(statusFromText(text) === want, `"${text}" → ${want}`, String(statusFromText(text)))
}
log(statusFromText('随便写的') === null, '认不出的值 → null（宁可不动也不能瞎改）')
log(statusFromText('') === null, '空值 → null')

console.log('\n[2] 本地状态 → Base 文案（推送方向）')
log(statusText({ status: 'open', followUp: true }) === '跟进中', 'open+followUp → 跟进中')
log(statusText({ status: 'open', followUp: false }) === '待处理', 'open → 待处理')
log(statusText({ status: 'done' }) === '已解决', 'done → 已解决')
log(statusText({ status: 'archived' }) === '不是问题', 'archived → 不是问题')
log(statusFromText(statusText({ status: 'done' })) === 'done', '往返一致（done）')
log(statusFromText(statusText({ status: 'open', followUp: true })) === 'open', '往返一致（跟进中→open）')

console.log('\n[3] 跟进人匹配（Base 文本 → 本地 assignee）')
const members = [
  { username: 'wxid_chenxixi', label: '陈西西' },
  { username: 'wxid_huangqiao', label: '黄巧' }
]
log(assigneeFromText('陈西西', members) === 'wxid_chenxixi', '按称呼命中 → 落 username')
log(assigneeFromText('wxid_huangqiao', members) === 'wxid_huangqiao', '直接填 username 也认')
log(assigneeFromText('颜总', members) === '颜总', '没在名单里也记下来（同事写自己名字不该被拒）')
log(assigneeFromText('  ', members) === null, '空 → 取消指派')

console.log('\n[4] 议题 → 字段（脱敏与截断）')
const issue = {
  id: 42,
  key: 'k',
  wxid: 'wxid_a',
  groupUsername: '123@chatroom',
  groupName: '保利星荟店对接群',
  type: '物流',
  title: 'A'.repeat(400),
  summary: '客户问到货进度',
  occurAt: 1789000000000,
  status: 'open',
  method: 'llm',
  severity: '高',
  followUp: true,
  assignee: 'wxid_chenxixi',
  createdAt: 1789000000000,
  updatedAt: 1789000001000,
  msgCount: 3
}
const fields = issueToFields(issue, new Map([['wxid_chenxixi', '陈西西']]))
log(fields['议题ID'] === '42', '议题ID 是字符串（Base 文本列）')
log(fields['状态'] === '跟进中', '状态按 followUp 细分')
log(fields['跟进人'] === '陈西西', '跟进人用名单里的称呼')
log(String(fields['标题']).length === 240, '超长标题截断到 240', String(String(fields['标题']).length))
log(!JSON.stringify(fields).includes('客户问到货进度') === false, '摘要照常推送')
log(!JSON.stringify(fields).includes('chatroom'), '不推内部 username（脱敏）')

console.log('\n[5] 读回 Base 的协作列（单选是字符串，人员字段可能是数组/对象）')
log(collabOf({ 状态: '已解决', 跟进人: '陈西西' }).status === '已解决', '纯文本')
log(collabOf({ 状态: [{ text: '已解决' }] }).status === '已解决', '数组形态 → 取 text')
log(collabOf({ 跟进人: { name: '陈西西' } }).assignee === '陈西西', '对象形态 → 取 name')
log(collabOf(undefined).status === '' && collabOf(undefined).assignee === '', '缺失字段 → 空串')

console.log('\n[6] 冲突比对（判断是不是同事改的）')
const last = { status: '待处理', assignee: '' }
log(!diffCollab({ status: '待处理', assignee: '' }, last).statusChanged, '没变 → 不算改动')
log(diffCollab({ status: '已解决', assignee: '' }, last).statusChanged, '状态变了 → 是同事改的')
log(diffCollab({ status: '待处理', assignee: '陈西西' }, last).assigneeChanged, '跟进人从空到有 → 是同事改的')
log(
  diffCollab({ status: '待处理', assignee: '' }, { status: '待处理', assignee: '陈西西' }).assigneeChanged,
  '跟进人被清空 → 也算改动'
)
log(!diffCollab({ status: '', assignee: '' }, last).statusChanged, '空状态不触发改动（避免误清本地状态）')
log(diffCollab({ status: '已解决', assignee: '' }, null).statusChanged, '首次拉取（无历史值）→ 视为改动')

console.log('\n[7] 内容 hash（决定要不要写）')
const h1 = hashOf({ a: 1, b: 'x' })
log(h1 === hashOf({ a: 1, b: 'x' }), '同内容 → 同 hash')
log(h1 !== hashOf({ a: 1, b: 'y' }), '内容变了 → hash 变')
log(hashOf({}).length === 16, 'hash 长度固定 16', String(hashOf({}).length))

console.log(failed === 0 ? '\n全部通过 ✅' : `\n${failed} 项未通过 ❌`)
process.exit(failed === 0 ? 0 : 1)
