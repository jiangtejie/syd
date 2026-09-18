#!/usr/bin/env node
/**
 * 能力注册表「契约」自检（纯元数据，零依赖、不联网、不碰库）：
 *   node --experimental-strip-types scripts/tool-registry-selftest.mjs
 *
 * 为什么需要它：能力一旦漏登记，表现是「模型说它没这个能力」——排查成本高、又不会报错。
 * 更早的坑：注册表里 readOnly 只认 send_message，新加的写类能力被当成只读（审批直接绕过）。
 * 所以这里把「声明层的规矩」钉死：目录行必须齐、写类必须标 confirm、参数必须有说明、
 * 枚举必须有可选项、上下文依赖必须声明清楚。
 *
 * 覆盖范围：营销域 14 个工具（growth/ai/toolMeta.ts）。飞书/软件/工作区三组是纯数组常量，
 * 结构更简单（name + oneLine + when），同样在下面按同一套规矩校验。
 */
import { GROWTH_TOOL_META } from '../src/main/services/growth/ai/toolMeta.ts'
import {
  GROUP_TEXT,
  LARK_CAPS,
  SOFTWARE_CAPS,
  WHEN_HINT,
  WS_CAPS
} from '../src/main/services/ai/cap/catalog.ts'

let failed = 0
const log = (ok, name, detail) => {
  if (!ok) failed++
  console.log(`${ok ? '  ok  ' : ' FAIL '} ${name}${detail ? ' — ' + detail : ''}`)
}

const tools = GROWTH_TOOL_META
console.log('\n[1] 营销域能力元数据')
log(tools.length === 14, '登记 14 个工具', String(tools.length))
const names = tools.map((t) => t.name)
log(new Set(names).size === names.length, '能力名唯一')
log(names.every((n) => /^growth_[a-z0-9_]+$/.test(n)), '命名一致(growth_snake_case)')
log(tools.every((t) => t.oneLine.trim().length >= 6), '每个能力都有一句话用途(目录行)')
log(tools.every((t) => t.when.trim().length >= 6), '每个能力都有触发场景(给模型)')
log(tools.every((t) => typeof t.confirm === 'boolean'), 'confirm 字段显式声明')

console.log('\n[2] 写操作必须走审批')
const writes = tools.filter((t) => t.confirm).map((t) => t.name)
const expectWrites = [
  'growth_gen_image',
  'growth_make_cover',
  'growth_rewrite_title',
  'growth_rewrite_copy',
  'growth_update_output',
  'growth_replace_image',
  'growth_save_store_fact',
  'growth_export_package',
  'growth_record_publish'
]
log(writes.length === expectWrites.length, '写类工具 9 个', writes.join(','))
log(expectWrites.every((n) => writes.includes(n)), '写类清单与预期一致')
const reads = tools.filter((t) => !t.confirm).map((t) => t.name)
log(
  reads.every((n) => !/^(growth_gen_image|growth_update_output|growth_record_publish)$/.test(n)),
  '只要改数据/花钱的能力都不在只读组'
)

console.log('\n[3] 参数声明完整(模型看到的就是这份)')
for (const t of tools) {
  const params = Object.entries(t.params ?? {})
  log(params.length > 0, `${t.name} 至少有一个参数或显式空对象`, String(params.length))
  log(
    params.every(([, p]) => typeof p.desc === 'string' && p.desc.trim().length >= 3),
    `${t.name} 每个参数都有说明`
  )
  const enums = params.filter(([, p]) => p.type === 'enum')
  log(
    enums.every(([, p]) => Array.isArray(p.enum) && p.enum.length >= 2),
    `${t.name} 枚举参数都有可选项`
  )
}

console.log('\n[4] 上下文依赖声明与参数一致')
for (const t of tools) {
  if (t.needsContent) {
    log(
      t.name === 'growth_read_material' || 'contentId' in (t.params ?? {}),
      `${t.name} 声明依赖素材 → 必须能显式传 contentId`
    )
  }
  if (t.needsStore) {
    log('storeId' in (t.params ?? {}), `${t.name} 声明依赖门店 → 必须能显式传 storeId`)
  }
  if (t.needsTask) {
    log('taskId' in (t.params ?? {}), `${t.name} 声明依赖任务 → 必须能显式传 taskId`)
  }
}

console.log('\n[5] 营销页上下文可用性')
const needContent = tools.filter((t) => t.needsContent).map((t) => t.name)
log(needContent.length > 0, '有明确依赖素材上下文的能力', String(needContent.length))
log(
  tools.filter((t) => t.needsContent).every((t) => !t.params.contentId?.required),
  'contentId 不设为必填(营销页会注入默认值,其它入口显式传)'
)


console.log('\n[6] 全能力目录契约（catalog.ts 纯数据，注册表与自检共用）')
{
  const groups = Object.entries(GROUP_TEXT)
  log(groups.length === 6, '六个分组都有展示名', groups.map(([k]) => k).join(','))
  log(groups.every(([, label]) => String(label).trim().length >= 2), '分组名非空')
  const buckets = {
    software: SOFTWARE_CAPS,
    cloud: LARK_CAPS,
    workspace: WS_CAPS,
    wechat: Object.entries(WHEN_HINT).map(([name, v]) => ({ name, ...v }))
  }
  for (const [group, list] of Object.entries(buckets)) {
    log(list.length > 0, `${group} 组非空`, String(list.length))
    log(
      list.every((c) => String(c.oneLine ?? '').trim().length >= 4),
      `${group} 组每条都有目录行`
    )
    log(
      list.every((c) => String(c.when ?? '').trim().length >= 4),
      `${group} 组每条都有触发场景`
    )
    log(
      list.every((c) => /^[a-z][a-z0-9_]*$/.test(c.name)),
      `${group} 组命名 snake_case`
    )
  }
  const all = [...Object.keys(WHEN_HINT), ...SOFTWARE_CAPS.map((c) => c.name), ...LARK_CAPS.map((c) => c.name), ...WS_CAPS.map((c) => c.name), ...GROWTH_TOOL_META.map((c) => c.name)]
  const dup = all.filter((n, i) => all.indexOf(n) !== i)
  log(dup.length === 0, '跨组能力名不重复（重名会让目录/挂载指向错的那一个）', dup.join(',') || '无重复')
  log(all.length === new Set(all).size, '能力总数 = 去重后数量', String(all.length))
}
console.log(failed === 0 ? '\n全部通过 ✅' : `\n${failed} 项未通过 ❌`)
process.exit(failed === 0 ? 0 : 1)
