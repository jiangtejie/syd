import Database from 'better-sqlite3-multiple-ciphers'
import { buildSync } from 'esbuild'
import { createRequire } from 'module'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { dirname, join } from 'path'
import { fileURLToPath } from 'url'

/**
 * 客户档案自检（临时真库跑真 DDL）。
 *
 * 钉住三件不能错的事：
 *  ① **会话同步绝不能覆盖用户填的来源/备注/标签** —— 同步每次打开客户页都跑，写坏了等于用户白填；
 *  ② 同一个客户重复同步不会建出第二行（username 是稳定身份，昵称/备注会变）；
 *  ③ 实时标签（会话算）与人工标签（库里的）分区清楚，合并没有串味。
 */

const require = createRequire(import.meta.url)
const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const work = mkdtempSync(join(tmpdir(), 'dsh-customer-archive-'))

let failed = 0
const ok = (cond, label, extra = '') => {
  console.log((cond ? '  ✔ ' : '  ✖ ') + label + (extra ? ' — ' + extra : ''))
  if (!cond) failed++
}

let db = null
try {
  const bStore = join(work, 'customerStore.cjs')
  buildSync({
    entryPoints: [join(root, 'src/main/db/customerStore.ts')],
    bundle: true, platform: 'node', format: 'cjs', outfile: bStore,
    external: ['better-sqlite3-multiple-ciphers']
  })
  const bSchema = join(work, 'customerSchema.cjs')
  buildSync({
    entryPoints: [join(root, 'src/main/db/schema/customer.ts')],
    bundle: true, platform: 'node', format: 'cjs', outfile: bSchema
  })
  const bProfile = join(work, 'customerProfile.cjs')
  buildSync({
    entryPoints: [join(root, 'src/shared/customerProfile.ts')],
    bundle: true, platform: 'node', format: 'cjs', outfile: bProfile
  })
  const S = require(bStore)
  const { CUSTOMER_TABLES, CUSTOMER_INDEXES } = require(bSchema)
  const { mergeCustomerProfile, statusTagsOf } = require(bProfile)

  db = new Database(join(work, 'customer.db'))
  for (const sql of [...CUSTOMER_TABLES, ...CUSTOMER_INDEXES]) db.exec(sql)

  const ACCT = 'wxid_main'
  const row = (username, over = {}) =>
    Object.assign({
      username,
      displayName: '保利星荟店',
      remark: '陈老板',
      nickname: '陈某某',
      alias: 'chen_xx',
      isGroup: false,
      lastActiveAt: 1_700_000_000_000
    }, over)

  console.log('首次同步（建档）：')
  const r1 = S.upsertCustomersFromSessions(db, ACCT, [row('u1'), row('u2', { isGroup: true })])
  ok(r1.inserted === 2 && r1.updated === 0, '两条都算新建', JSON.stringify(r1))
  const m1 = S.listCustomerProfiles(db, ACCT)
  ok(m1.size === 2, '列表返回两条')
  ok(m1.get('u1').firstSeenAt !== null, '首次见到时间已写入')
  ok(m1.get('u2').isGroup === true, '群标记保留')

  console.log('重复同步（幂等，不建重复行）：')
  const r2 = S.upsertCustomersFromSessions(db, ACCT, [row('u1')])
  ok(r2.inserted === 0 && r2.updated === 1, '第二次只算更新', JSON.stringify(r2))
  const m2 = S.listCustomerProfiles(db, ACCT)
  ok(m2.size === 2, '★ 仍然只有两行（username 是稳定身份，不会因改名多出一行）')
  const firstSeen1 = m1.get('u1').firstSeenAt
  ok(m2.get('u1').firstSeenAt === firstSeen1, '建档时间不会被后续同步改写')

  console.log('★ 用户数据不被同步覆盖（本文件最重要的一条）：')
  S.updateCustomerFields(db, ACCT, 'u1', { source: '抖音探店视频', note: '大客户，账期 30 天' })
  S.setCustomerTag(db, ACCT, 'u1', '大客户')
  S.setCustomerTag(db, ACCT, 'u1', '慎报价')
  S.setCustomerTag(db, ACCT, 'u1', '系统算出', 'derived')
  const before = S.listCustomerProfiles(db, ACCT).get('u1')
  ok(before.source === '抖音探店视频', '来源已保存')
  ok(before.note === '大客户，账期 30 天', '备注已保存')
  ok(before.manualTags.length === 2 && before.derivedTags.length === 1, '人工标签与规则标签分区')

  // 同步时微信侧字段变了（改了备注与昵称）——用户数据必须原样活着
  S.upsertCustomersFromSessions(db, ACCT, [
    row('u1', { remark: '陈总（新备注）', nickname: '新昵称', lastActiveAt: 1_800_000_000_000 })
  ])
  const after = S.listCustomerProfiles(db, ACCT).get('u1')
  ok(after.source === '抖音探店视频', '★ 同步后来源还在')
  ok(after.note === '大客户，账期 30 天', '★ 同步后备注还在')
  ok(after.manualTags.length === 2, '★ 同步后人工标签还在')
  ok(after.remark === '陈总（新备注）', '微信侧备注被更新（该同步的还是要同步）')
  ok(after.lastActiveAt === 1_800_000_000_000, '最近活跃推进')

  console.log('最近活跃不回退：')
  S.upsertCustomersFromSessions(db, ACCT, [row('u1', { lastActiveAt: 1_000 })])
  ok(S.listCustomerProfiles(db, ACCT).get('u1').lastActiveAt === 1_800_000_000_000, '★ 旧时间不会把最近活跃改回去')

  console.log('标签操作：')
  S.setCustomerTag(db, ACCT, 'u1', '大客户')
  ok(S.listCustomerProfiles(db, ACCT).get('u1').manualTags.length === 2, '重复打同一个标签不会多出一条（幂等）')
  ok(S.removeCustomerTag(db, ACCT, 'u1', '慎报价') === 1, '删除返回受影响行数')
  ok(S.listCustomerProfiles(db, ACCT).get('u1').manualTags.length === 1, '删除后只剩一个')
  ok(S.removeCustomerTag(db, ACCT, 'u1', '不存在') === 0, '删不存在的标签返回 0（不报错）')

  console.log('未建档也能填来源/备注（免去「先建档」的别扭）：')
  const created = S.updateCustomerFields(db, ACCT, 'u9', { source: '门店扫码' })
  ok(created === true, '为不存在的客户写入成功')
  ok(S.listCustomerProfiles(db, ACCT).get('u9').source === '门店扫码', '来源已落库')
  ok(S.updateCustomerFields(db, ACCT, 'u9', {}) === false, '空 patch 不改动（返回 false）')

  console.log('按账号隔离：')
  const other = S.listCustomerProfiles(db, 'wxid_other')
  ok(other.size === 0, '另一个账号看不到本账号的客户')
  // 前后的本账号行取快照对比：不要拿某个具体字段硬编码期望值 —— 上面几次同步本来就该改 remark，
  // 拿它当不变量会测出假失败（第一版就是这么写错的）。
  const beforeOther = S.listCustomerProfiles(db, ACCT).get('u1')
  S.upsertCustomersFromSessions(db, 'wxid_other', [row('u1', { displayName: '同 username 但别的账号' })])
  const afterOther = S.listCustomerProfiles(db, ACCT).get('u1')
  ok(
    afterOther.remark === beforeOther.remark &&
      afterOther.source === beforeOther.source &&
      afterOther.firstSeenAt === beforeOther.firstSeenAt,
    '★ 别的账号写同一个 username 不影响本账号'
  )
  ok(
    S.listCustomerProfiles(db, 'wxid_other').get('u1').displayName === '同 username 但别的账号',
    '另一个账号自己那条正常写入'
  )

  console.log('合并语义（实时 vs 持久）：')
  const session = {
    username: 'u1', displayName: '会话里的名字', remark: '', nickname: '', alias: '',
    isGroup: false, lastTimestamp: 1_700_000_000_000, unreadCount: 3, summary: '最后一条', isPinned: false
  }
  const stored = S.listCustomerProfiles(db, ACCT).get('u1')
  const view = mergeCustomerProfile(session, stored, 1_800_000_000_000)
  ok(view.name === '会话里的名字', '展示名以会话为准（改名后立刻反映）')
  ok(view.source === '抖音探店视频' && view.note === '大客户，账期 30 天', '来源/备注以档案为准')
  ok(view.manualTags.length === 1, '人工标签带出来')
  ok(view.unreadCount === 3 && view.lastActive === 1_700_000_000_000, '实时字段来自会话')
  const noStored = mergeCustomerProfile(session, null, 0)
  ok(noStored.source === '' && noStored.manualTags.length === 0, '没建档时安全降级（空档案）')

  console.log('实时状态标签：')
  const now = 1_800_000_000_000
  ok(statusTagsOf({ ...session, unreadCount: 0 }, now).includes('待回复') === false, '没有未读 → 不是待回复')
  const urgent = statusTagsOf({ ...session, unreadCount: 2, lastTimestamp: now - 5 * 3600_000 }, now)
  ok(urgent.includes('待回复') && urgent.includes('超时未回'), '有未读且超 2h → 待回复 + 超时未回')
  const sleeping = statusTagsOf({ ...session, unreadCount: 0, lastTimestamp: now - 10 * 86400_000 }, now)
  ok(sleeping.includes('沉睡客户'), '7~30 天未联系 → 沉睡客户')
  ok(statusTagsOf({ ...session, isGroup: true, unreadCount: 0 }, now).includes('群聊') === true, '群标记')
} finally {
  try { if (db) db.close() } catch { /* ignore */ }
  try { rmSync(work, { recursive: true, force: true }) } catch { /* Windows 偶发占用 */ }
}

console.log(failed === 0 ? '\n全部通过 ✅' : '\n' + failed + ' 项失败 ❌')
process.exit(failed === 0 ? 0 : 1)
