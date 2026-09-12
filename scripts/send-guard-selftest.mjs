#!/usr/bin/env node
/**
 * 发送前目标校验 + 发送后文本比对自检（纯函数，零依赖不联网）：
 *   node --experimental-strip-types scripts/send-guard-selftest.mjs
 *
 * 为什么必须测：发消息靠「搜会话名 → 回车打开第一个结果」，判错就是**发错群且收不回**。
 * 这里把重名/前缀撞车/包含关系三类危险场景钉死，避免以后有人「顺手放宽」判定。
 */
import {
  normalizeForCompare,
  normalizeName,
  pickUniqueTarget,
  searchKey,
  textMatchesSent,
  sessionBurstCheck,
  contentDupCheck
} from '../src/main/services/send/guard.ts'

let failed = 0
const log = (ok, name, detail) => {
  if (!ok) failed++
  console.log(`${ok ? '  ok  ' : ' FAIL '} ${name}${detail ? ' — ' + detail : ''}`)
}

const S = (username, displayName) => ({ username, displayName })

console.log('\n[1] 唯一目标 → 放行，并回传真实展示名用于注入')
const okList = [
  S('g1@chatroom', '杨老头成都保利星荟店物配对接群'),
  S('g2@chatroom', '喜甜 & 奶茶桶纸杯 采购群'),
  S('u1', '颜总')
]
const r1 = pickUniqueTarget(okList, 'g1@chatroom', '杨老头成都保利星荟店物配对接群')
log(r1.ok, '唯一 → 放行')
log(r1.name === '杨老头成都保利星荟店物配对接群', '注入名取列表里的真实名', r1.name)
const r1b = pickUniqueTarget(okList, 'g1@chatroom', '旧的群名（已改名）')
log(
  r1b.ok && r1b.name === '杨老头成都保利星荟店物配对接群',
  '传入名过时时以列表真实名为准',
  r1b.name
)

console.log('\n[2] 同名会话 → 拒绝（这是最常见的错发来源）')
const dup = [S('g1', '杨老头成都保利星荟店物配对接群'), S('g2', '杨老头成都保利星荟店物配对接群')]
const r2 = pickUniqueTarget(dup, 'g1', '杨老头成都保利星荟店物配对接群')
log(!r2.ok, '同名 → 拒绝')
log(/同名会话/.test(r2.error ?? ''), '错误信息点明同名', r2.error)

console.log('\n[3] 前缀撞车（超长名截断后相同）→ 拒绝')
const longA = 'A'.repeat(40) + '店'
const longB = 'A'.repeat(40) + '仓'
const r3 = pickUniqueTarget([S('g1', longA), S('g2', longB)], 'g1', longA)
log(!r3.ok, '前 30 字相同 → 拒绝', r3.error)

console.log('\n[4] 包含关系 → 拒绝（短名群最危险）')
const r4 = pickUniqueTarget([S('g1', '宜家'), S('g2', '宜家德邦快运群')], 'g1', '宜家')
log(!r4.ok, '「宜家」会命中「宜家德邦快运群」→ 拒绝', r4.error)
const r4b = pickUniqueTarget(
  [S('g1', '保利星荟店物配对接群'), S('g2', '物配对接群')],
  'g1',
  '保利星荟店物配对接群'
)
log(!r4b.ok, '别人的名字是自己的子串 → 拒绝', r4b.error)

console.log('\n[5] 目标不在列表里 → 按唯一性放行（刚建的群/列表还没刷新）')
const r5 = pickUniqueTarget([S('g2', '别的群')], 'gNew', '新拉的客户群')
log(r5.ok, '不在列表但无冲突 → 放行', r5.note)

console.log('\n[6] 归一化与搜索词')
log(
  normalizeName('  杨老头　成都 ') === '杨老头 成都',
  '全角空格/首尾空白归一',
  normalizeName('  杨老头　成都 ')
)
log(normalizeName('a\u200bb') === 'ab', '零宽字符去掉')
log(
  searchKey('x'.repeat(50)).length === 30,
  '搜索词截断到 30 字与注入脚本一致',
  String(searchKey('x'.repeat(50)).length)
)
log(pickUniqueTarget(okList, 'g1@chatroom', '   ').ok === false, '空名 → 拒绝')

console.log('\n[7] 发送后文本比对（容忍空白/零宽/截断）')
log(textMatchesSent('您好，孜然粉到货了，我帮您安排', '您好，孜然粉到货了，我帮您安排'), '完全相同')
log(
  textMatchesSent('您好， 孜然粉\n到货了，我帮您安排', '您好，孜然粉到货了，我帮您安排'),
  '换行/空格差异仍算匹配'
)
log(
  textMatchesSent('您好，孜然粉到货了，我帮您安排一下，明天发出', '您好，孜然粉到货了，我帮您安排'),
  '库里更长（带后缀）→ 匹配'
)
log(!textMatchesSent('今天发货', '你好，请问到货了吗'), '内容不同 → 不匹配')
log(!textMatchesSent('', 'abc'), '空文本 → 不匹配（避免误判成功）')
log(
  normalizeForCompare('x'.repeat(200)).length === 80,
  '比对只在归一化后前 80 字',
  String(normalizeForCompare('x'.repeat(200)).length)
)

console.log('\n[8] 风控：同会话连发（机器连发是特征，正常客服不该被挡）')
const now = Date.now()
const ago = (sec) => now - sec * 1000
log(sessionBurstCheck([], now, 90, 3).ok, '该会话没发过 → 放行')
log(sessionBurstCheck([ago(10), ago(30)], now, 90, 3).ok, '90 秒内已发 2 条 → 放行（这是第 3 条）')
log(
  !sessionBurstCheck([ago(10), ago(30), ago(50)], now, 90, 3).ok,
  '90 秒内已发 3 条 → 拦截第 4 条'
)
const b = sessionBurstCheck([ago(10), ago(30), ago(50)], now, 90, 3)
log(
  b.count === 3 && b.waitSec > 0,
  '拦截时给出已发条数与还需等待秒数',
  `count=${b.count} wait=${b.waitSec}s`
)
log(sessionBurstCheck([ago(200), ago(300)], now, 90, 3).ok, '窗口外的不算（人慢节奏回复不受影响）')
log(!sessionBurstCheck([ago(89)], now, 90, 1).ok, '窗口 90s + 上限 1 条 = 「硬间隔」口径也成立')
log(sessionBurstCheck([ago(1), ago(2), ago(3)], now, 0, 3).ok, '窗口 0 → 关闭该限制')
log(sessionBurstCheck([ago(1), ago(2), ago(3), ago(4)], now, 90, 0).ok, '上限 0 → 关闭该限制')

console.log('\n[9] 风控：内容重复率（同文案群发是风控第一触发点）')
const sameText = '您好，孜然粉到货了，我帮您安排'
const dupRows = (n) =>
  Array.from({ length: n }, (_, i) => ({ sessionId: `g${i}@chatroom`, message: sameText }))
log(contentDupCheck(dupRows(19), sameText, 20).ok, '已发 19 个会话 → 放行（这是第 20 条）')
log(!contentDupCheck(dupRows(20), sameText, 20).ok, '已发 20 个会话 → 拦截')
log(contentDupCheck(dupRows(50), '今天发货安排一下', 20).ok, '内容不同 → 放行')
log(
  contentDupCheck([{ sessionId: 'a', message: ' 您好， 孜然粉\n到货了，我帮您安排 ' }], sameText, 1)
    .sessions === 1,
  '空白/换行差异算同一条文案'
)
log(
  contentDupCheck(
    [
      { sessionId: 'a@chatroom', message: sameText },
      { sessionId: 'a@chatroom', message: sameText }
    ],
    sameText,
    5
  ).sessions === 1,
  '同一会话发多次只算一个会话'
)
log(contentDupCheck(dupRows(50), sameText, 0).ok, '阈值 0 → 不限制')
log(contentDupCheck([], sameText, 1).ok, '窗口内没有记录 → 放行')

console.log(failed === 0 ? '\n全部通过 ✅' : `\n${failed} 项未通过 ❌`)
process.exit(failed === 0 ? 0 : 1)
