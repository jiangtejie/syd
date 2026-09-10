import type Database from 'better-sqlite3-multiple-ciphers'
import { LEGACY_TABLES, RESERVED_TABLES } from './reserved'

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

/** 表是否存在 */
function hasTable(db: Database.Database, name: string): boolean {
  return !!db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?").get(name)
}

/** 数值兜底：非有限数返回 null */
function num0(v: unknown): number | null {
  const n = Number(v)
  return Number.isFinite(n) ? n : null
}

/** 表行数（不存在返回 0） */
function rowCount(db: Database.Database, name: string): number {
  if (!hasTable(db, name)) return 0
  const r = db.prepare('SELECT COUNT(*) AS c FROM "' + name + '"').get() as { c: number }
  return r.c
}

export const DATA_MIGRATIONS: DataMigration[] = [
  {
    id: 3,
    name: 'drop-legacy-and-empty-reserved-tables',
    /**
     * 清掉两类「库里有的表 ≠ 代码在用的表」：
     * - 已下线功能遗留（phrase_book / skill_package / agent_memory / ai_custom_tool / ai_mcp_server）；
     * - 预留但从未接入、且确认是空的表（customer / session / tier_rule / knowledge_item /
     *   reply_decision）—— 有数据就不动，避免误删别人手工塞过的东西。DDL 留在 reserved.ts。
     */
    run: (db) => {
      for (const t of LEGACY_TABLES) db.exec('DROP TABLE IF EXISTS "' + t + '"')
      for (const t of Object.keys(RESERVED_TABLES)) {
        if (hasTable(db, t) && rowCount(db, t) === 0) db.exec('DROP TABLE IF EXISTS "' + t + '"')
      }
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
  }
]

/** 当前 schema 版本 = 最后一条迁移的 id（user_version 会对齐到它） */
export const SCHEMA_VERSION = DATA_MIGRATIONS.reduce((m, x) => Math.max(m, x.id), 0)
