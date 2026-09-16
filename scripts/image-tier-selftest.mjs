#!/usr/bin/env node
/**
 * 图片档位（高清原图 / 默认图 / 缩略图）优先级与标注口径的自检（纯函数，零依赖）：
 *   node --experimental-strip-types scripts/image-tier-selftest.mjs
 *
 * 为什么值得钉死：这条顺序决定大图预览、飞书证据附件、上报归档拿到的是 181KB 的高清原图
 * 还是 4KB 的缩略图，而它的失败方式恰恰最难发现 —— 回退成功、ok:true、图糊了但没人报错。
 * 早期 orig 的兜底是 orig → thumb → hd（缩略图压在高清前面），正是这里要拦下的那类错。
 */
import {
  IMAGE_TIERS,
  degradedReasonText,
  isBetterTier,
  normalizeKind,
  tierLabel,
  tierOrder,
  tierRank,
  tierSuffix,
  tierTallyText
} from '../src/shared/imageTier.ts'

let failed = 0
const log = (ok, name, detail) => {
  if (!ok) failed++
  console.log(`${ok ? '  ok  ' : ' FAIL '} ${name}${detail ? ' — ' + detail : ''}`)
}
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b)

console.log('\n[1] 请求语义 → 尝试顺序（由好到差）')
log(
  eq(tierOrder(), ['hd', 'orig', 'thumb']),
  '缺省即 best：高清 → 默认 → 缩略图',
  tierOrder().join(' → ')
)
log(eq(tierOrder('best'), ['hd', 'orig', 'thumb']), 'best 显式传入同义')
log(eq(tierOrder('hd'), ['hd', 'orig', 'thumb']), 'hd 首选高清')
log(
  eq(tierOrder('orig'), ['orig', 'hd', 'thumb']),
  'orig 的兜底把高清排在缩略图前面（旧实现的颠倒顺序就是这条被钉死的错）',
  tierOrder('orig').join(' → ')
)
log(eq(tierOrder('thumb'), ['thumb', 'orig', 'hd']), 'thumb（列表气泡）从最省的一档起步')

console.log('\n[2] 任何请求都不丢档：三档全在序列里，缺失时还能兜底')
for (const kind of ['best', 'hd', 'orig', 'thumb']) {
  const order = tierOrder(kind)
  log(
    order.length === 3 && IMAGE_TIERS.every((t) => order.includes(t)),
    `${kind} 覆盖全部三档`,
    order.join(' → ')
  )
  log(order[0] === (kind === 'best' ? 'hd' : kind), `${kind} 首选档位正确`, order[0])
}

console.log('\n[3] 后缀与中文口径（界面/日志/飞书附件名共用）')
log(
  tierSuffix('orig') === '' && tierSuffix('thumb') === '_t' && tierSuffix('hd') === '_h',
  '后缀对应 <md5>.dat / _t.dat / _h.dat'
)
log(
  tierLabel('hd') === '高清原图' &&
    tierLabel('orig') === '默认图' &&
    tierLabel('thumb') === '缩略图',
  '三档中文口径'
)
log(tierLabel(undefined) === '默认图', '档位缺失时按「默认图」说，不吹成原图')

console.log('\n[4] 优劣比较：决定缓存里那份够不够好、要不要重传')
log(
  tierRank('hd') < tierRank('orig') && tierRank('orig') < tierRank('thumb'),
  'hd 优于 orig 优于 thumb'
)
log(tierRank(undefined) === IMAGE_TIERS.length, '未知档位排最差', String(tierRank(undefined)))
log(isBetterTier('hd', 'orig') && !isBetterTier('orig', 'hd'), '只有更好才重传')
log(isBetterTier('orig', 'thumb'), '默认图好过缩略图 → 值得重传')
log(!isBetterTier(undefined, 'thumb'), '手里没有档位信息不算更好（不重复上传）')
log(isBetterTier('thumb', undefined), '缓存里档位未知（老数据）时，手里这份算更好')

console.log('\n[5] 归一化：IPC/旧前端传未知值一律按 best')
log(normalizeKind(undefined) === 'best' && normalizeKind('') === 'best', '缺省/空 → best')
log(normalizeKind('hd') === 'hd' && normalizeKind('thumb') === 'thumb', '已知档位原样透传')
log(normalizeKind('HD') === 'best', '大小写不认（宁可要高清，也不猜用户想要缩略图）')

console.log('\n[6] 归档日志文案：全高清不写噪音，有降级才写详情')
const tally = (hd, orig, thumb) => ({ hd, orig, thumb })
log(tierTallyText(tally(0, 0, 0)) === '', '没有图片 → 不追加任何文案')
log(tierTallyText(tally(5, 0, 0)) === '（图片全为高清原图）', '全高清 → 一句话带过')
log(
  tierTallyText(tally(3, 2, 0)) === '（图片档位:高清 3 / 默认 2 / 缩略 0）',
  '有默认图 → 写全三档计数'
)
log(
  tierTallyText(tally(3, 2, 1)).includes('缩略图1 张是微信里没点开查看原图'),
  '有缩略图 → 顺带说清为什么糊'
)

console.log('\n[7] 降级原因文案：可修复的要直接给出修复动作（用户看到的是糊图，不是日志）')
log(
  degradedReasonText('ffmpeg-missing').includes('ffmpeg') &&
    degradedReasonText('ffmpeg-missing').includes('设置'),
  'ffmpeg 缺失 → 文案指到「设置 → 图片解密 → ffmpeg 路径」'
)
log(degradedReasonText('hevc-decode-failed').length > 0, 'HEVC 解不出 → 也有可读说明')

if (failed > 0) {
  console.error(`\n${failed} 项失败`)
  process.exit(1)
}
console.log('\n全部通过')
