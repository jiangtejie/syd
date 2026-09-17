import { buildSync } from 'esbuild'
import { createRequire } from 'module'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { dirname, join } from 'path'
import { fileURLToPath } from 'url'

/**
 * 议题稳定 ID 自检（纯函数）。
 *
 * 钉住的事故形态：Base 同步以前用**本地自增行号**当议题标识，两台机器各自从 1 开始编号，
 * A 机的 #12 与 B 机的 #12 是不同议题却写进同一张多维表格 → 拉回时互相覆盖，
 * 同事对 B 议题的处置被写到 A 的议题上，而且表面看不出异常。
 * 这里断言「同号不同议题必须有不同的稳定 ID」，并锁住旧字段没被动过。
 */

const require = createRequire(import.meta.url)
const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const work = mkdtempSync(join(tmpdir(), 'dsh-lark-uid-'))

let failed = 0
const ok = (cond, label, extra = '') => {
  console.log((cond ? '  ✔ ' : '  ✖ ') + label + (extra ? ' — ' + extra : ''))
  if (!cond) failed++
}

try {
  const bundle = join(work, 'baseMapping.cjs')
  buildSync({
    entryPoints: [join(root, 'src/main/services/lark/baseMapping.ts')],
    bundle: true,
    platform: 'node',
    format: 'cjs',
    outfile: bundle
  })
  const { issueUid, UID_FIELD, issueToFields } = require(bundle)

  const issue = (over) =>
    Object.assign(
      {
        id: 12,
        key: 'k-锚点-1',
        wxid: 'wxid_a',
        groupUsername: 'g1@chatroom',
        groupName: '保利星荟店对接群',
        type: '物流',
        title: '孜然粉到货',
        summary: '客户问到货时间',
        occurAt: 1_700_000_000_000,
        updatedAt: 1_700_000_100_000,
        status: 'open',
        followUp: false,
        assignee: '',
        severity: '一般',
        msgCount: 3,
        method: 'llm'
      },
      over
    )

  console.log('稳定 ID 的形状：')
  const uid = issueUid('wxid_a', 'k1')
  ok(/^[0-9a-f]{16}$/.test(uid), '16 位小写 hex', uid)
  ok(issueUid('wxid_a', 'k1') === uid, '同输入同输出（可复现，重启不漂）')
  ok(issueUid('wxid_a', 'k2') !== uid, '同账号不同议题 → 不同 ID')
  ok(issueUid('wxid_b', 'k1') !== uid, '不同账号同 key → 不同 ID（不会误合并）')
  ok(issueUid('', 'k1') !== issueUid('wxid_a', 'k1'), '空 wxid 也不与真账号碰撞')

  console.log('多机器共表（真正的回归点）：')
  const mA = issueToFields(issue({ wxid: 'wxid_a', key: 'A 的议题' }), new Map())
  const mB = issueToFields(issue({ wxid: 'wxid_b', key: 'B 的议题' }), new Map())
  ok(mA['议题ID'] === '12' && mB['议题ID'] === '12', '两台机器的本地行号确实都是 12（这正是坑）')
  ok(
    mA[UID_FIELD] && mB[UID_FIELD] && mA[UID_FIELD] !== mB[UID_FIELD],
    '稳定 ID 不同 → 拉回时不会再互相覆盖',
    String(mA[UID_FIELD]) + ' vs ' + String(mB[UID_FIELD])
  )
  const repeat = issueToFields(issue({ wxid: 'wxid_a', key: 'A 的议题' }), new Map())
  ok(repeat[UID_FIELD] === mA[UID_FIELD], '同一议题重复推送 → 稳定 ID 不变（幂等）')

  console.log('旧字段没被动过：')
  for (const k of ['议题ID', '客户群', '类型', '严重度', '标题', '摘要', '状态', '跟进人', '首现时间', '最近更新', '证据条数']) {
    ok(k in mA, '保留列「' + k + '」')
  }
  ok(UID_FIELD === '议题UID', '列名常量与文档一致', UID_FIELD)
  ok(issueToFields(issue({ followUp: true }), new Map())['状态'] === '跟进中', '状态文案不受影响')
} finally {
  try {
    rmSync(work, { recursive: true, force: true })
  } catch {
    /* Windows 偶发占用 */
  }
}

console.log(failed === 0 ? '\n全部通过 ✅' : '\n' + failed + ' 项失败 ❌')
process.exit(failed === 0 ? 0 : 1)
