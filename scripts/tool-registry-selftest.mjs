#!/usr/bin/env node
/**
 * 能力目录「契约」自检（纯元数据，零依赖、不联网、不碰库）：
 *   node --experimental-strip-types scripts/tool-registry-selftest.mjs
 *
 * 为什么需要它：能力一旦漏登记，表现是「模型说它没这个能力」——排查成本高、又不会报错。
 * 更早的坑：注册表里 readOnly 只认 send_message，新加的写类能力被当成只读（审批直接绕过）。
 * 所以这里把「声明层的规矩」钉死：目录行必须齐、命名一致、跨组不重名、中文名不残留。
 *
 * 覆盖范围：catalog.ts 的四组纯数据常量 —— 微信业务（WHEN_HINT）/ 软件（SOFTWARE_CAPS）/
 * 飞书云文档（LARK_CAPS）/ 工作区（WS_CAPS）。
 *
 * 注：营销域（原 growth/ai/toolMeta.ts）曾在这里按「目录行 / 写类 confirm / 参数说明 /
 * 上下文依赖」逐条校验，2026-09 该模块整体下线后连带删除 —— 那套更严的规矩只对带 params
 * 的富元数据有意义，剩下的四组是简单数组（name + oneLine + when）。
 */
import { TOOL_CN_NAMES, toolCnName } from '../src/shared/types.ts'
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

/** 四组能力桶：分组名与 catalog.ts 的 CapGroup 一一对应 */
const buckets = {
  wechat: Object.entries(WHEN_HINT).map(([name, v]) => ({ name, ...v })),
  software: SOFTWARE_CAPS,
  cloud: LARK_CAPS,
  workspace: WS_CAPS
}

console.log('\n[1] 全能力目录契约（catalog.ts 纯数据，注册表与自检共用）')
{
  const groups = Object.entries(GROUP_TEXT)
  log(groups.length === 5, '五个分组都有展示名', groups.map(([k]) => k).join(','))
  log(groups.every(([, label]) => String(label).trim().length >= 2), '分组名非空')
  log(
    Object.keys(buckets).every((g) => g in GROUP_TEXT),
    '每个能力桶都能在 GROUP_TEXT 里找到展示名'
  )
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
  const all = Object.values(buckets)
    .flat()
    .map((c) => c.name)
  const dup = all.filter((n, i) => all.indexOf(n) !== i)
  log(dup.length === 0, '跨组能力名不重复（重名会让目录/挂载指向错的那一个）', dup.join(',') || '无重复')
  log(all.length === new Set(all).size, '能力总数 = 去重后数量', String(all.length))
}

console.log('\n[2] 中文名表（对话与工具时间线里给用户看的是它，不是英文标识）')
{
  const names = Object.entries(TOOL_CN_NAMES)
  log(names.length > 0, '中文名表非空', String(names.length))
  log(
    names.every(([, cn]) => /[\u4e00-\u9fa5]/.test(String(cn))),
    '每个中文名都真的含汉字（不能是英文原样）'
  )
  log(
    names.every(([, cn]) => String(cn).length <= 8),
    '每个中文名够短（时间线一行放得下）'
  )
  /**
   * ★ 已下线的能力不许在中文名表里留残留。
   *
   * 营销域（growth_*）2026-09 整体下线：它的中文名若留在 TOOL_CN_NAMES 里，这张表就永远
   * 比实际能力多一截 —— 而这张表的用途正是「新增能力必须在这里补一行」，基线被撑大，
   * 这条规矩就废了。toolCnName() 对认不出的名字回落到原名，所以残留不会报错，只会静默变脏。
   */
  const dead = Object.keys(TOOL_CN_NAMES).filter((k) => k.startsWith('growth'))
  log(dead.length === 0, '★ 已下线营销域的中文名已清干净', dead.join(',') || '无残留')
  log(toolCnName('不存在的工具名') === '不存在的工具名', '未登记的名字回落到原名（不抛错）')
}

console.log(failed === 0 ? '\n全部通过 ✅' : `\n${failed} 项未通过 ❌`)
process.exit(failed === 0 ? 0 : 1)
