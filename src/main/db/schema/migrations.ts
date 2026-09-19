import type Database from 'better-sqlite3-multiple-ciphers'
import { LEGACY_TABLES } from './reserved'

/**
 * 一次性数据迁移（按 user_version 门控，只跑一次）。
 *
 * 与 base.ts / columns.ts 的分工：那两处是幂等 DDL（每次启动对齐形状），这里放
 * 「改形状 / 搬数据 / 清旧表」这类跑第二遍会出问题或已无意义的动作，并且真的读
 * PRAGMA user_version 来决定跑到哪一步 —— 之前版本号只是写着好看。
 *
 * 编号从 3 起：历史版本把 `PRAGMA user_version` 写成 2 却没有读过它，老库因此停在 2 ——
 * 新迁移必须大于这个假版本号，否则在老库上会被整段跳过（第一次演练就踩到了）。
 *
 * 加迁移的规矩：
 * - 只能往后追加，id 递增，永不改历史条目的语义；
 * - 每条在本文件外统一包事务，失败向上抛，启动即暴露而不是留下半迁移；
 * - 幂等性不做强要求（有版本门控），但要能容忍目标不存在（老库版本各异）。
 */
export interface DataMigration {
  id: number
  name: string
  run: (db: Database.Database) => void
}

/** 数值兜底：非有限数返回 null */
function num0(v: unknown): number | null {
  const n = Number(v)
  return Number.isFinite(n) ? n : null
}

interface ColInfo {
  name: string
  type: string
  notnull: number
  dflt_value: string | null
  pk: number
}

/**
 * 放宽老库里「遗留列」的 NOT NULL 约束：按列重建表并原样搬数据。
 *
 * 为什么需要：代码演进时删掉的常常只是**建表 DDL 里的那一行**，而 CREATE TABLE IF NOT EXISTS
 * 从不修改既有表 —— 老库里那一列还在，而且往往还是 NOT NULL 无默认值，于是「当前代码的 INSERT
 * 不写它」就变成每次写入都撞 NOT NULL constraint failed。用户侧的观感是「功能时好时坏/模型在胡说」，
 * 排查却要从「库形状」这一层才能看出来（实测：growth_remix_output.job_id、growth_output_asset.updated_at）。
 *
 * 为什么不是 ALTER TABLE DROP COLUMN：① 老库上这些列带着索引，SQLite 会直接拒绝；
 * ② 我们要的不是「删数据」而是「放宽约束」—— 遗留列里的值留着（它们是好数据），NULL 完全合理。
 */
function relaxNotNull(db: Database.Database, table: string, relax: string[]): boolean {
  const info = db.prepare('PRAGMA table_info(' + table + ')').all() as ColInfo[]
  if (info.length === 0) return false
  const hit = info.filter((c) => relax.includes(c.name) && c.notnull === 1)
  if (hit.length === 0) return false

  const row = db
    .prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?")
    .get(table) as { sql?: string } | undefined
  /** 还原 AUTOINCREMENT（PRAGMA 读不到它）：丢了会让删除后的 id 被复用，历史引用可能错位 */
  const autoinc = /AUTOINCREMENT/i.test(row?.sql ?? '')

  const defs = info.map((c) => {
    const relaxed = hit.some((h) => h.name === c.name)
    const parts = ['"' + c.name + '"', c.type || 'TEXT']
    if (c.pk === 1 && autoinc) parts.push('PRIMARY KEY AUTOINCREMENT')
    else if (c.pk === 1) parts.push('PRIMARY KEY')
    if (!relaxed && c.notnull === 1) parts.push('NOT NULL')
    if (c.dflt_value !== null && c.dflt_value !== undefined)
      parts.push('DEFAULT ' + String(c.dflt_value))
    return parts.join(' ')
  })
  const names = info.map((c) => '"' + c.name + '"').join(', ')
  const tmp = table + '__relax_notnull'
  db.exec('CREATE TABLE "' + tmp + '" (' + defs.join(', ') + ')')
  db.exec('INSERT INTO "' + tmp + '" (' + names + ') SELECT ' + names + ' FROM "' + table + '"')
  db.exec('DROP TABLE "' + table + '"')
  db.exec('ALTER TABLE "' + tmp + '" RENAME TO "' + table + '"')
  return true
}

export const DATA_MIGRATIONS: DataMigration[] = [
  {
    id: 3,
    name: 'drop-legacy-tables',
    /**
     * 清掉已下线功能留下的表（phrase_book / skill_package / agent_memory / ai_custom_tool /
     * ai_mcp_server）—— 「库里有的表 ≠ 代码在用的表」会让排查先被误导一轮。
     *
     * **收窄过一次（B1）**：这条迁移原本还会把「预留且为空」的业务表一并 DROP
     * （customer / session / tier_rule / knowledge_item / reply_decision）。那条逻辑本身没错
     * ——问题在于**每次新装库都会执行一次**，于是「客户表」在任何一台新机器上都会被建出来又删掉，
     * 客户资产永远是零。现在客户档案已改名为 customer_profile 并由基座 DDL 常驻建表
     * （见 schema/customer.ts），这里只清真正下线的表。
     * 已经跑过老版本迁移的库：被删的是空表，没有数据损失。
     */
    run: (db) => {
      for (const t of LEGACY_TABLES) db.exec('DROP TABLE IF EXISTS "' + t + '"')
    }
  },
  {
    id: 4,
    name: 'issue-state-from-app-config',
    /**
     * 问题引擎的分析状态从 app_config 的 JSON 串搬进两张状态表：
     * - issue.wm:<wxid>:<group>       → issue_group_state 增量水位（msgTime + sortSeq）
     * - issue.groupAt:<wxid>:<group>  → issue_group_state 自动分析节流戳（at/method/count/error/coverage）
     * - issue.analyzed:<wxid>         → issue_account_state 最近一次全量重析结果
     * - issue.analyzeFail:<wxid>      → issue_account_state 失败标记
     * 搬完删键；空值键（旧代码用 setConfig(key,'') 当删除）直接清掉，不再留空行。
     */
    run: (db) => {
      const rows = db
        .prepare(
          "SELECT key, value FROM app_config WHERE key LIKE 'issue.wm:%'" +
            " OR key LIKE 'issue.groupAt:%' OR key LIKE 'issue.analyzed:%'" +
            " OR key LIKE 'issue.analyzeFail:%'"
        )
        .all() as Array<{ key: string; value: string | null }>
      const upsert = db.prepare(
        'INSERT INTO issue_group_state (account_wxid, group_username, updated_at)' +
          ' VALUES (?, ?, ?) ON CONFLICT(account_wxid, group_username) DO NOTHING'
      )
      const setWm = db.prepare(
        'UPDATE issue_group_state SET wm_at = ?, wm_msg_time = ?, wm_sort_seq = ?, updated_at = ?' +
          ' WHERE account_wxid = ? AND group_username = ?'
      )
      const setStamp = db.prepare(
        'UPDATE issue_group_state SET last_at = ?, last_method = ?, last_count = ?, last_error = ?,' +
          ' coverage_msgs = ?, coverage_truncated = ?, updated_at = ?' +
          ' WHERE account_wxid = ? AND group_username = ?'
      )
      const del = db.prepare('DELETE FROM app_config WHERE key = ?')
      const setAccountState = db.prepare(
        'UPDATE issue_account_state SET last_at = ?, last_method = ?, last_count = ?,' +
          ' last_groups = ?, last_groups_total = ?, last_capped = ?, last_cancelled = ?,' +
          ' updated_at = ? WHERE account_wxid = ?'
      )
      const setAccountFail = db.prepare(
        'UPDATE issue_account_state SET fail_at = ?, fail_error = ?, updated_at = ?' +
          ' WHERE account_wxid = ?'
      )
      const upsertAccount = db.prepare(
        'INSERT INTO issue_account_state (account_wxid, updated_at) VALUES (?, ?)' +
          ' ON CONFLICT(account_wxid) DO NOTHING'
      )
      const now = Date.now()
      for (const r of rows) {
        del.run(r.key)
        const raw = (r.value ?? '').trim()

        // 账号级状态：整键即账号，无 group 段
        const isState = r.key.startsWith('issue.analyzed:')
        const isFail = r.key.startsWith('issue.analyzeFail:')
        if (isState || isFail) {
          if (!raw) continue
          const account = r.key.slice((isState ? 'issue.analyzed:' : 'issue.analyzeFail:').length)
          if (!account) continue
          let p: Record<string, unknown>
          try {
            p = JSON.parse(raw) as Record<string, unknown>
          } catch {
            continue
          }
          upsertAccount.run(account, now)
          if (isState) {
            const at = Number(p.at)
            if (!Number.isFinite(at)) continue
            setAccountState.run(
              at,
              p.method === 'llm' || p.method === 'rule' ? String(p.method) : null,
              num0(p.count),
              num0(p.groups),
              num0(p.groupsTotal),
              p.capped ? 1 : 0,
              p.cancelled ? 1 : 0,
              now,
              account
            )
          } else {
            setAccountFail.run(
              num0(p.at),
              typeof p.error === 'string' && p.error ? p.error.slice(0, 500) : null,
              now,
              account
            )
          }
          continue
        }

        if (!raw) continue
        const isWm = r.key.startsWith('issue.wm:')
        const rest = r.key.slice(isWm ? 'issue.wm:'.length : 'issue.groupAt:'.length)
        const sep = rest.indexOf(':')
        if (sep <= 0) continue
        const wxid = rest.slice(0, sep)
        const group = rest.slice(sep + 1)
        if (!wxid || !group) continue
        let parsed: Record<string, unknown>
        try {
          parsed = JSON.parse(raw) as Record<string, unknown>
        } catch {
          continue // 坏值直接丢弃（旧代码读到时也是按 null 处理）
        }
        upsert.run(wxid, group, now)
        if (isWm) {
          const msgTime = Number(parsed.msgTime)
          if (!Number.isFinite(msgTime)) continue
          const at = Number(parsed.at)
          const seq = Number(parsed.sortSeq)
          setWm.run(
            Number.isFinite(at) ? at : null,
            msgTime,
            Number.isFinite(seq) ? seq : null,
            now,
            wxid,
            group
          )
        } else {
          const at = Number(parsed.at)
          if (!Number.isFinite(at)) continue
          const count = Number(parsed.count)
          const cov = parsed.coverage as { msgs?: unknown; truncated?: unknown } | undefined
          const msgs = Number(cov?.msgs)
          setStamp.run(
            at,
            parsed.method === 'llm' || parsed.method === 'rule' ? String(parsed.method) : null,
            Number.isFinite(count) ? count : null,
            typeof parsed.error === 'string' && parsed.error ? parsed.error : null,
            Number.isFinite(msgs) ? msgs : null,
            cov?.truncated ? 1 : 0,
            now,
            wxid,
            group
          )
        }
      }
    }
  },
  {
    id: 5,
    name: 'issue-evidence-dedupe-and-unique-index',
    /**
     * 证据行加唯一约束 (issue_id, seq)：防重复追加导致 msgCount 虚高。
     * 先按 (issue_id, seq) 去重（保留 id 最小的一条），再建唯一索引；seq 为 NULL 的行
     * SQLite 视为互不相同，不受影响。历史上靠应用层 mergeEvidence 保证，这里补库层保险。
     */
    run: (db) => {
      db.exec(
        'DELETE FROM issue_feedback_msg WHERE seq IS NOT NULL' +
          ' AND id NOT IN (SELECT MIN(id) FROM issue_feedback_msg GROUP BY issue_id, seq)'
      )
      db.exec(
        'CREATE UNIQUE INDEX IF NOT EXISTS idx_issue_fb_msg_uniq ON issue_feedback_msg(issue_id, seq)'
      )
    }
  },
  {
    id: 6,
    name: 'rename-default-agent',
    /**
     * 产品改名：内置默认智能体「微信私域智能客服」→「私域运营助手」。
     *
     * 为什么用迁移而不是只改播种值：播种只在**空库**发生，老库里那一行永远是旧名 ——
     * 用户会在「AI 助手 → 智能体」里看到两个名字并存（新装的机器叫新名，自己的机器叫旧名）。
     *
     * 只改**名字与旧默认值逐字相同**的那一行，且限定 id='builtin-default'（播种时写死的 id）：
     * 用户自己改过名字的人设一律不动 —— 改名的本意是统一产品口径，不是替用户决定他的人设叫什么。
     * 这里的名字写字面量（不引 shared/appInfo.ts）：历史条目要定格当时的事实，不能被未来的改名影响。
     */
    run: (db) => {
      db.prepare('UPDATE ai_agent SET name = ?, updated_at = ? WHERE id = ? AND name = ?').run(
        '私域运营助手',
        Date.now(),
        'builtin-default',
        '微信私域智能客服'
      )
    }
  },
  {
    id: 7,
    name: 'relax-legacy-growth-notnull-columns',
    /**
     * 老库里两张营销产出表的遗留 NOT NULL 列，让当前代码的写入**每次都失败**：
     *
     * 1) growth_remix_output.job_id —— 一键爆改时代的任务外键。58629e0 删掉一键爆改链路时
     *    只删了建表 DDL 里那一行，老库里 job_id INTEGER NOT NULL 至今还在，而 createOutput()
     *    的 INSERT 不带它 → 「生成标题 / 生成正文 / 生成配图」全部撞
     *    NOT NULL constraint failed: growth_remix_output.job_id。
     *    实测后果：任务 5 里模型拿到工具报错后，编了一套「请用户手动建产出块并把 outputId 告我」
     *    的流程 —— 手工建块走的是同一条 INSERT，一样会失败；错的不是模型的态度，是库形状。
     * 2) growth_output_asset.updated_at —— 早期版本的建表 DDL 里带这一列且 NOT NULL 无默认，
     *    同一个提交改成不写它之后，凡是「那一版建过表」的库，挂图（生图 / 换封面 / 换配图）
     *    都会失败。本机这台的老库没有这一列（放宽是无害的 no-op），但别的机器可能有 —— 一并放宽。
     *
     * 这两列里的旧值是好数据（老产出与老勾稽关系），所以是放宽约束而不是删列。
     * 顺带清掉 job_id 上的老索引（一键爆改下线后已无人查它）。
     */
    run: (db) => {
      db.exec('DROP INDEX IF EXISTS idx_growth_remix_out_job')
      relaxNotNull(db, 'growth_remix_output', ['job_id'])
      relaxNotNull(db, 'growth_output_asset', ['updated_at'])
    }
  }
]

/** 当前 schema 版本 = 最后一条迁移的 id（user_version 会对齐到它） */
export const SCHEMA_VERSION = DATA_MIGRATIONS.reduce((m, x) => Math.max(m, x.id), 0)
