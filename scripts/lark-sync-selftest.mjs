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
  evidenceKindText,
  evidenceToFields,
  hashOf,
  issueToFields,
  originText,
  parseManualMap,
  personFieldValue,
  replyToFields,
  riskText,
  statusFromText,
  statusText
} from '../src/main/services/lark/baseMapping.ts'
import {
  EVIDENCE_MEDIA_PARENT_TYPE,
  attachmentFieldValue,
  decideEvidenceMedia,
  evidenceMediaName,
  imageMd5Of,
  isEvidenceImage,
  maxMediaBytesOf
} from '../src/main/services/lark/evidenceMedia.ts'
import { fmtHms, fmtStamp, fmtTimeShort } from '../src/shared/monitorMetrics.ts'
import { isRecordMissingError } from '../src/main/services/lark/errorClass.ts'
import { collectFieldPages } from '../src/main/services/lark/fieldPages.ts'
import { buildGroupIssuesText } from '../src/main/services/lark/issueDigest.ts'
import {
  actionValueOf,
  approvalCard,
  operatorOpenIdOf,
  parseApprovalAction
} from '../src/main/services/im/cards.ts'
// 人员列的两个纯函数放在 baseMapping(与证据映射同源),这里直接离线导入

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
const last = { status: '待处理', assignee: '', note: '' }
log(!diffCollab({ status: '待处理', assignee: '' }, last).statusChanged, '没变 → 不算改动')
log(diffCollab({ status: '已解决', assignee: '' }, last).statusChanged, '状态变了 → 是同事改的')
log(diffCollab({ status: '待处理', assignee: '陈西西' }, last).assigneeChanged, '跟进人从空到有 → 是同事改的')
log(
  diffCollab({ status: '待处理', assignee: '' }, { status: '待处理', assignee: '陈西西' }).assigneeChanged,
  '跟进人被清空 → 也算改动'
)
log(!diffCollab({ status: '', assignee: '' }, last).statusChanged, '空状态不触发改动（避免误清本地状态）')
log(diffCollab({ status: '已解决', assignee: '', note: '' }, null).statusChanged, '首次拉取（无历史值）→ 视为改动')
log(diffCollab({ status: '', assignee: '', note: '已联系客户' }, last).noteChanged, '处理备注从空到有 → 是同事改的')
log(!diffCollab({ status: '待处理', assignee: '', note: '已联系客户' }, { status: '待处理', assignee: '', note: '已联系客户' }).any, '三列都没变 → any=false（不写不拉）')
log(collabOf({ 处理备注: '已安排补发' }).note === '已安排补发', '读回处理备注')

console.log('\n[6.1] 数字员工回复 → Base 字段')
const reply = {
  id: 7,
  groupName: '保利星荟店对接群',
  groupUsername: '123@chatroom',
  triggerText: 'X'.repeat(400),
  decision: 'script',
  intent: '到货时间',
  replyText: '我帮您查到货进度',
  riskLevel: 'A',
  status: 'shadow',
  feedback: 'good',
  triggerTime: 1789000000000,
  createdAt: 1789000000000
}
const rf = replyToFields(reply)
log(rf['回复ID'] === '7', '回复ID 是字符串')
log(rf['判定'] === '命中话术', '决策来源 → 中文文案')
log(rf['风险'] === 'A 可自动', '风险等级 → 文案')
log(rf['状态'] === '影子（待看）', 'shadow → 影子（待看）')
log(rf['人工反馈'] === '答得对', '本地反馈 → 文案')
log(String(rf['触发消息']).length === 120, '触发消息默认截断 120 字', String(String(rf['触发消息']).length))
log(String(replyToFields(reply, 500)['触发消息']).length === 400, '打开「推送原文」后放宽到 500（原文 400 字不截）')
log(replyToFields({ ...reply, status: 'rejected' })['状态'] === '已驳回', '已驳回状态映射')
log(riskText('C') === 'C 禁自动' && riskText(undefined) === 'A 可自动', 'riskText 边界')

console.log('\n[7] 内容 hash（决定要不要写）')
const h1 = hashOf({ a: 1, b: 'x' })
log(h1 === hashOf({ a: 1, b: 'x' }), '同内容 → 同 hash')
log(h1 !== hashOf({ a: 1, b: 'y' }), '内容变了 → hash 变')
log(hashOf({}).length === 16, 'hash 长度固定 16', String(hashOf({}).length))

console.log('\n[8] 议题证据 → 「议题证据」子表字段')
const ev = {
  msgId: 91,
  issueId: 42,
  issueTitle: '客户问到货进度',
  groupName: '保利星荟店对接群',
  seqNo: 3,
  time: 1789000000000,
  senderName: '张三',
  isSend: false,
  isTeam: false,
  text: 'Y'.repeat(500),
  localType: 1
}
const ef = evidenceToFields(ev)
log(ef['证据ID'] === '91', '证据ID 是字符串（幂等键）')
log(ef['议题ID'] === '42' && ef['序号'] === 3, '议题ID / 序号带上（子表可分组排序）')
log(ef['来源'] === '客户', '非我方非同事 → 客户')
log(
  originText(true, false) === '我方' && originText(false, true) === '我方同事' && originText(false, false) === '客户',
  '来源三态文案'
)
log(originText(true, true) === '我方', '两个标记同时为真时以「我方」优先（is_send 更可信）')
log(String(ef['内容']).length === 200, '内容默认截断 200 字', String(String(ef['内容']).length))
log(
  String(evidenceToFields(ev, { maxChars: 2000 })['内容']).length === 500,
  '放宽上限后原文 500 字不截'
)
log(evidenceToFields({ ...ev, text: '', imageMd5: 'abc', localType: 3 })['内容'] === '[图片]', '纯图片 → 占位 [图片]')
log(
  evidenceToFields({ ...ev, text: '看下这个', imageMd5: 'abc', localType: 3 })['内容'] === '[图片] 看下这个',
  '图配文 → 占位 + 文字'
)
log(evidenceKindText(34, undefined) === '语音', 'local_type=34 → 语音')
log(evidenceKindText(43, undefined) === '视频', 'local_type=43 → 视频')
log(evidenceKindText(47, undefined) === '表情', 'local_type=47 → 表情')
log(
  !JSON.stringify(evidenceToFields(ev)).includes('chatroom'),
  '证据行不带内部 username（这是 senderUsername，不写进表）'
)
log(
  !Object.keys(evidenceToFields(ev)).some((k) => k === '处理备注' || k === '状态'),
  '证据表只用标准列名（不套议题表的列名映射）'
)

console.log('\n[9] 证据附件：上传决策（纯函数）')
const MB = 1024 * 1024
log(isEvidenceImage(3, undefined), 'local_type=3 → 是图片')
log(isEvidenceImage(49, 'A'.repeat(32).toLowerCase()), '带合法 image_md5 → 是图片')
log(!isEvidenceImage(1, undefined), '纯文本 → 不是图片')
log(imageMd5Of('  ABCDEF0123456789ABCDEF0123456789 ') === 'abcdef0123456789abcdef0123456789', 'md5 归一化（去空格+小写）')
log(imageMd5Of('not-a-md5') === null, '非法 md5 → null')
log(
  decideEvidenceMedia({ localType: 3, imageMd5: 'a'.repeat(32), maxBytes: 10 * MB }).action ===
    'attach',
  '正常图片 → 上传'
)
log(
  decideEvidenceMedia({
    localType: 3,
    imageMd5: 'a'.repeat(32),
    cachedToken: 'tok',
    maxBytes: 10 * MB
  }).action === 'cached',
  '已上传过 → 复用 token（不再走网络）'
)
const big = decideEvidenceMedia({
  localType: 3,
  imageMd5: 'a'.repeat(32),
  sizeBytes: 12 * MB,
  maxBytes: 10 * MB
})
log(big.action === 'skip' && big.reason === 'too-big', '超过单张上限 → 跳过（保留占位文本）')
log(
  decideEvidenceMedia({ localType: 1, maxBytes: 10 * MB }).action === 'skip',
  '非图片证据 → 不传附件'
)
log(
  decideEvidenceMedia({ localType: 3, imageMd5: 'zz', maxBytes: 10 * MB }).reason === 'no-md5',
  '图片但没有合法 md5 → no-md5'
)
log(maxMediaBytesOf(10) === 10 * MB, '10MB → 字节数')
log(maxMediaBytesOf(999) === 20 * MB, '超过 20MB 的上限被夹到 20（飞书单次上限）')
log(maxMediaBytesOf(0) === 1 * MB, '低于 1MB 的配置夹到 1')
log(evidenceMediaName('abcdef0123456789abcdef0123456789', 'jpg') === 'image_abcdef01.jpg', '附件名只带 md5 前缀（不泄露客户信息）')
log(evidenceMediaName('abcdef0123456789abcdef0123456789', '.JPEG') === 'image_abcdef01.jpeg', '扩展名归一化')
log(evidenceMediaName('abcdef0123456789abcdef0123456789', '') === 'image_abcdef01.jpg', '认不出扩展名 → 兜底 jpg')
log(
  JSON.stringify(attachmentFieldValue('tok')) === '[{"file_token":"tok"}]',
  '附件字段值形状 [{file_token}]（飞书要求）'
)
log(EVIDENCE_MEDIA_PARENT_TYPE === 'bitable_image', '父类型=bitable_image（多维表格图片）')

console.log('\n[10] 时间口径：一律精确到时分秒（共享实现，渲染端与主进程同一份）')
const SAMPLE = 1789000000000
const STAMP_RE = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/
const HMS_RE = /^\d{2}:\d{2}:\d{2}$/
log(STAMP_RE.test(fmtStamp(SAMPLE)), 'fmtStamp → YYYY-MM-DD HH:mm:ss', fmtStamp(SAMPLE))
log(fmtStamp(SAMPLE).endsWith(':' + String(new Date(SAMPLE).getSeconds()).padStart(2, '0')), '最后一段就是秒（不是 00 占位）')
log(fmtStamp(0) === '—' && fmtStamp(undefined) === '—', '空值 → —（不落到 1970）')
log(HMS_RE.test(fmtHms(SAMPLE)), 'fmtHms → HH:mm:ss', fmtHms(SAMPLE))
log(HMS_RE.test(fmtHms(0)) === false && fmtHms(0) === '—', 'fmtHms 空值 → —')
const shortToday = fmtTimeShort(Date.now())
log(shortToday.startsWith('今天 ') && HMS_RE.test(shortToday.slice(3)), '今天 → 今天 HH:mm:ss', shortToday)
log(fmtTimeShort(SAMPLE).includes(':') && fmtTimeShort(SAMPLE).split(':').length === 3, '非今天 → … HH:mm:ss', fmtTimeShort(SAMPLE))
log(fmtTimeShort(0) === '—', 'fmtTimeShort 空值 → —')

console.log('\n[11] 人员列：称呼 → open_id 的映射解析（纯函数）')
const parsed = parseManualMap(
  ['# 注释行', '陈西西=ou_abc123', '黄巧：ou_def456', '  ', '格式不对的一行', '王五 = ou_ghi789'].join('\n')
)
log(parsed['陈西西'] === 'ou_abc123', '等号写法', JSON.stringify(parsed['陈西西']))
log(parsed['黄巧'] === 'ou_def456', '全角冒号也认', JSON.stringify(parsed['黄巧']))
log(parsed['王五'] === 'ou_ghi789', '两侧空格容错', JSON.stringify(parsed['王五']))
log(Object.keys(parsed).length === 3, '注释/空行/非法行被忽略', String(Object.keys(parsed).length))
log(JSON.stringify(personFieldValue('ou_x')) === '[{"id":"ou_x"}]', '人员字段值形状 [{id}]（飞书要求）')


console.log('\n[12] 飞书错误分类：记录没了 vs 字段类错误（历史事故：过宽判定导致重复插入）')
for (const [msg, want] of [
  ['RecordIdNotFound', true],
  ['record not found', true],
  ['Record not found: recuXyZ', true],
  ['记录不存在', true],
  ['FieldNameNotFound', false],
  ['1254302: FieldNameNotFound', false],
  ['InvalidFieldValue', false],
  ['1254005: InvalidFieldValue', false],
  ['1254 列缺失', false],
  ['rate limit exceeded', false],
  ['', false]
]) {
  log(isRecordMissingError(msg) === want, `${JSON.stringify(msg)} → ${want}`, String(isRecordMissingError(msg)))
}

console.log('\n[13] 列元信息分页聚合（假 transport，不联网）')
{
  const pages = [
    { items: [{ field_id: 'f1', field_name: '标题', type: 1 }, { field_id: 'f2', field_name: '状态', type: 3 }], has_more: true, page_token: 't1' },
    { items: [{ field_id: 'f3', field_name: '跟进人', type: 11 }], has_more: false }
  ]
  let calls = 0
  const tokens = []
  const all = await collectFieldPages(async (tk) => {
    calls++
    tokens.push(tk)
    return pages[calls - 1]
  })
  log(all.length === 3, '两页拼接 → 3 列', String(all.length))
  log(calls === 2, 'has_more=false 后停止请求', 'calls=' + calls)
  log(tokens[0] === undefined && tokens[1] === 't1', '第二页带上 page_token')
  log(all[0].primary === true && all[1].primary === false && all[2].primary === false, '主字段兜底只给「第一页第一条」')
  log(all.map((f) => f.name).join(',') === '标题,状态,跟进人', '顺序与字段名保持原样')

  let cap = 0
  const capped = await collectFieldPages(async () => {
    cap++
    return { items: [{ field_name: 'x' + cap }], has_more: true, page_token: 'p' + cap }
  }, 3)
  log(cap === 3 && capped.length === 3, '页数上限生效（防跑飞）', 'calls=' + cap)

  const skipped = await collectFieldPages(async () => ({
    items: [{ field_id: 'x' }, { field_name: ' 名称带空格 ' }],
    has_more: false
  }))
  log(skipped.length === 1 && skipped[0].name === '名称带空格', '无名字段跳过 + 名字去空白', JSON.stringify(skipped))

  const explicit = await collectFieldPages(async () => ({
    items: [{ field_name: 'a', is_primary: true }, { field_name: 'b', is_primary: true }],
    has_more: false
  }))
  log(explicit[1].primary === true, '飞书明确回 is_primary 时以它为准')
}

console.log('\n[14] 群问题 → 飞书摘要文案（工作台「发到飞书」与 AI 工具共用口径）')
{
  const base = { id: 1, type: '物流', status: 'open', occurText: '今天 08:00:00' }
  const empty = buildGroupIssuesText({
    groupName: '保利星荟店对接群',
    nowText: '2026-09-13 10:12:33',
    issues: []
  })
  log(empty.includes('【群问题】保利星荟店对接群'), '标题带群名', empty.split('\n')[0])
  log(empty.includes('当前没有未闭环的问题'), '无未闭环 → 明确说明')

  const mixed = buildGroupIssuesText({
    groupName: '南部店物配对接群',
    nowText: '2026-09-13 10:12:33',
    issues: [
      { ...base, id: 1, title: '孜然粉到货', severity: '紧急' },
      { ...base, id: 2, title: '鸡爪到不了', followUp: true, assignee: '陈西西' },
      { ...base, id: 3, title: '对账单没收到', followUp: true, followUpOverdue: true },
      { ...base, id: 4, title: '已解决的旧问题', status: 'done' },
      { ...base, id: 5, title: '已归档的', status: 'archived' }
    ]
  })
  log(mixed.includes('未闭环 3 条（待处理 1 · 跟进中 1 · 跟进超时 1）'), '统计口径', mixed.split('\n')[1])
  log(!mixed.includes('已解决的旧问题') && !mixed.includes('已归档的'), 'done/archived 不进摘要')
  log(mixed.includes('1. [紧急][物流]孜然粉到货'), '序号 + 严重度/类型标签', mixed.split('\n')[3])
  log(mixed.includes('跟进:陈西西'), '跟进人显示')
  log(mixed.includes('2. [物流]鸡爪到不了'), '无严重度时不出现空标签')

  const many = buildGroupIssuesText({
    groupName: 'X 群',
    limit: 2,
    nowText: '2026-09-13 10:12:33',
    issues: [1, 2, 3, 4].map((n) => ({ ...base, id: n, title: '问题' + n }))
  })
  log(many.includes('仅列前 2 条，共 4 条未闭环'), '超出上限时给尾注', many.split('\n').slice(-1)[0])
  log(many.split('\n').filter((l) => /^\d+\. /.test(l)).length === 2, '真的只列 2 条')
}

console.log('\n[15] 工具审批卡片（按钮 value 是发送端与回调端的唯一契约）')
{
  const card = approvalCard({ toolName: '发送微信消息', args: '给「保利星荟店对接群」发：好的', runId: 'run-1', operatorOpenId: 'ou_me' })
  const els = card.elements
  const action = els.find((e) => e.tag === 'action')
  log(card.header.template === 'orange' && card.header.title.content.includes('需要你确认'), '卡片头是「需要你确认」', card.header.title.content)
  log(Array.isArray(action.actions) && action.actions.length === 2, '两个按钮', String(action.actions.length))
  log(action.actions[0].value.k === 'tool_approval' && action.actions[0].value.d === 'allow', '确认按钮 value 带动作标识')
  log(action.actions[1].value.d === 'deny', '取消按钮 value 为 deny')
  log(action.actions[0].value.op === 'ou_me' && action.actions[1].value.op === 'ou_me', '两个按钮都带发起人(只允许本人确认)')
  log(els.some((e) => e.tag === 'div' && e.text.content.includes('参数：')), '参数段落')
  log(els.some((e) => e.tag === 'note' && e.elements[0].content.includes('回复「确认」')), '备注说明按钮与文本两条路都能用')

  const noArgs = approvalCard({ toolName: 'X', runId: 'run-2' })
  log(!noArgs.elements.some((e) => e.tag === 'div' && String(e.text.content).includes('参数：')), '无参数时不出现参数段')
  log(noArgs.elements.find((e) => e.tag === 'action').actions[0].value.op === undefined, '未指定发起人时不写 op(沿用不校验)')
  const longArgs = approvalCard({ toolName: 'X', args: 'x'.repeat(500), runId: 'r' })
  log(longArgs.elements.find((e) => e.tag === 'div' && String(e.text.content).startsWith('参数：')).text.content.length < 260, '参数截断到 200 字内')

  log(parseApprovalAction({ k: 'tool_approval', runId: 'r1', d: 'allow' }).allow === true, '解析:确认')
  log(parseApprovalAction({ k: 'tool_approval', runId: 'r1', d: 'deny' }).allow === false, '解析:取消')
  log(parseApprovalAction({ k: 'tool_approval', runId: 'r1', d: 'allow', op: 'ou_x' }).operatorOpenId === 'ou_x', '解析:带发起人')
  log(parseApprovalAction({ k: 'other', runId: 'r1', d: 'allow' }) === null, '别的卡片的 value 不认领')
  log(parseApprovalAction({ k: 'tool_approval', d: 'allow' }) === null, '缺 runId → null')
  log(parseApprovalAction({ k: 'tool_approval', runId: 'r1', d: 'maybe' }) === null, '非法动作 → null')
  log(parseApprovalAction(null) === null && parseApprovalAction('x') === null, '非对象 → null')

  const payload = { operator: { operator_id: { open_id: 'ou_a' } }, action: { value: { k: 'tool_approval' } } }
  log(actionValueOf(payload).k === 'tool_approval', '从回调里取 value')
  log(operatorOpenIdOf(payload) === 'ou_a', '从回调里取操作者(operator_id.open_id)')
  log(operatorOpenIdOf({ operator: { open_id: 'ou_b' } }) === 'ou_b', '兼容 operator.open_id 形状')
  log(operatorOpenIdOf({}) === '', '取不到返回空串')
}
console.log(failed === 0 ? '\n全部通过 ✅' : `\n${failed} 项未通过 ❌`)
process.exit(failed === 0 ? 0 : 1)
