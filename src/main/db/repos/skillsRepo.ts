import { getDb } from '../database'
import type { SkillManifest, SkillPackageItem } from '../../../shared/types'

/** skill_package(声明式第三方技能包)持久化。 */

interface Row {
  id: number
  name: string
  version: string
  kind: string
  description: string
  author: string
  manifest: string
  hash: string
  enabled: number
  installed_at: number
  updated_at: number
}

export function rowToPackage(r: Row): SkillPackageItem {
  return {
    id: r.id,
    name: r.name,
    version: r.version,
    kind: r.kind === 'knowledge' ? 'knowledge' : 'tool',
    description: r.description,
    author: r.author || undefined,
    enabled: r.enabled === 1,
    createdAt: r.installed_at,
    updatedAt: r.updated_at
  }
}

export function listSkillPackages(): SkillPackageItem[] {
  const rows = getDb()
    .prepare(`SELECT * FROM skill_package ORDER BY installed_at ASC`)
    .all() as Row[]
  return rows.map(rowToPackage)
}

export function getSkillManifest(name: string): SkillManifest | null {
  const row = getDb().prepare(`SELECT manifest FROM skill_package WHERE name = ?`).get(name) as
    { manifest: string } | undefined
  if (!row) return null
  try {
    return JSON.parse(row.manifest) as SkillManifest
  } catch {
    return null
  }
}

export function listEnabledSkills(): Array<{ name: string; manifest: SkillManifest }> {
  const rows = getDb()
    .prepare(`SELECT name, manifest FROM skill_package WHERE enabled = 1`)
    .all() as Array<{ name: string; manifest: string }>
  const out: Array<{ name: string; manifest: SkillManifest }> = []
  for (const r of rows) {
    try {
      out.push({ name: r.name, manifest: JSON.parse(r.manifest) as SkillManifest })
    } catch {
      /* 坏 manifest 跳过 */
    }
  }
  return out
}

export function saveSkillPackage(info: {
  name: string
  version: string
  kind: string
  description: string
  author?: string
  manifest: SkillManifest
  hash: string
}): { ok: boolean; error?: string } {
  const db = getDb()
  const now = Date.now()
  const dup = db.prepare(`SELECT id FROM skill_package WHERE name = ?`).get(info.name) as
    { id: number } | undefined
  if (dup)
    return { ok: false, error: `已安装同名技能「${info.name}」,请先删除或在新版本中更换名称` }
  db.prepare(
    `INSERT INTO skill_package (name, version, kind, description, author, manifest, hash, enabled, installed_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, ?)`
  ).run(
    info.name,
    info.version,
    info.kind,
    info.description,
    info.author ?? '',
    JSON.stringify(info.manifest),
    info.hash,
    now,
    now
  )
  return { ok: true }
}

export function removeSkillPackage(id: number): boolean {
  const info = getDb().prepare(`DELETE FROM skill_package WHERE id = ?`).run(id)
  return info.changes > 0
}

export function toggleSkillPackage(id: number, enabled: boolean): boolean {
  const info = getDb()
    .prepare(`UPDATE skill_package SET enabled = ?, updated_at = ? WHERE id = ?`)
    .run(enabled ? 1 : 0, Date.now(), id)
  return info.changes > 0
}

/** 计算目录内容哈希(安装确认与溯源用) */
export function hashSkillManifest(manifest: SkillManifest): string {
  let h = 2166136261
  const s = JSON.stringify(manifest)
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i)
    h = Math.imul(h, 16777619)
  }
  return (h >>> 0).toString(16)
}
