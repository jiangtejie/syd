import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { ipcMain } from 'electron'
import {
  listSkillPackages,
  saveSkillPackage,
  removeSkillPackage,
  toggleSkillPackage,
  hashSkillManifest
} from '../db/repos/skillsRepo'
import { listCustomTools } from '../db/repos/customToolRepo'
import { ALL_TOOLS } from '../services/ai/chat/skills'
import type { SkillInstallInfo, SkillManifest, SkillParamDecl } from '../../shared/types'

/**
 * 第三方技能包 IPC(声明式;一期:tool=http 白名单 / knowledge=受控知识)。
 * 安装流程:inspect(目录)→ 渲染端展示能力摘要与风险 → install(确认后落库)。
 */

const NAME_RE = /^[a-zA-Z_][a-zA-Z0-9_]{1,40}$/
const METHODS = new Set(['GET', 'HEAD', 'POST', 'PUT', 'PATCH'])

function parseManifest(
  raw: string
): { ok: true; manifest: SkillManifest } | { ok: false; error: string } {
  let obj: unknown
  try {
    obj = JSON.parse(raw)
  } catch {
    return { ok: false, error: 'skill.json 不是合法 JSON' }
  }
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) {
    return { ok: false, error: 'skill.json 顶层须为对象' }
  }
  const m = obj as Record<string, unknown>
  const name = typeof m.name === 'string' ? m.name.trim() : ''
  const version = typeof m.version === 'string' ? m.version.trim() : ''
  const kind = m.kind
  const description = typeof m.description === 'string' ? m.description.trim() : ''
  if (!NAME_RE.test(name)) return { ok: false, error: '技能名需为字母开头,仅字母数字下划线(≤40)' }
  if (!version) return { ok: false, error: '缺少版本(version)' }
  if (kind !== 'tool' && kind !== 'knowledge')
    return { ok: false, error: 'kind 仅支持 tool|knowledge' }
  if (!description) return { ok: false, error: '缺少描述(description)' }

  const manifest: SkillManifest = {
    name,
    version,
    kind,
    description,
    author: typeof m.author === 'string' ? m.author.trim() : undefined,
    homepage: typeof m.homepage === 'string' ? m.homepage.trim() : undefined
  }

  if (kind === 'tool') {
    const t = m.tool
    if (!t || typeof t !== 'object' || Array.isArray(t)) {
      return { ok: false, error: 'tool 类技能缺少 tool 配置' }
    }
    const tc = t as Record<string, unknown>
    const url = typeof tc.url === 'string' ? tc.url.trim() : ''
    const methodRaw = typeof tc.method === 'string' ? tc.method.toUpperCase() : 'GET'
    if (!url) return { ok: false, error: 'tool.url 不能为空' }
    if (!METHODS.has(methodRaw))
      return { ok: false, error: `tool.method 仅支持 ${[...METHODS].join('/')}` }
    if (!/^https?:\/\//.test(url)) return { ok: false, error: 'tool.url 需以 http(s):// 开头' }
    if (!/^https:\/\//.test(url) && !/^http:\/\/(localhost|127\.0\.0\.1|\[::1\])/i.test(url)) {
      return { ok: false, error: '出于安全仅允许 https 或本机 http(localhost/127.0.0.1)' }
    }
    const method = methodRaw as 'GET' | 'HEAD' | 'POST' | 'PUT' | 'PATCH'
    const rawParams: unknown[] = Array.isArray(tc.params) ? tc.params : []
    const params = rawParams.filter(
      (p): p is SkillParamDecl =>
        !!p && typeof p === 'object' && typeof (p as { name?: unknown }).name === 'string'
    )
    manifest.tool = {
      url,
      method,
      params,
      headers:
        tc.headers && typeof tc.headers === 'object' && !Array.isArray(tc.headers)
          ? (tc.headers as Record<string, string>)
          : undefined
    }
  } else {
    if (typeof m.knowledge !== 'string' || !m.knowledge.trim()) {
      return { ok: false, error: 'knowledge 类技能缺少 knowledge 文本' }
    }
    manifest.knowledge = m.knowledge
  }
  return { ok: true, manifest }
}

function capabilitiesOf(m: SkillManifest): string[] {
  if (m.kind === 'knowledge') {
    return [
      '注入受控知识文本(自动拼入对话上下文,长度受限,不注册为工具)',
      m.author ? `作者:${m.author}` : '',
      m.homepage ? `主页:${m.homepage}` : ''
    ].filter(Boolean)
  }
  return [
    `HTTP ${m.tool?.method ?? 'GET'} 请求:${m.tool?.url}`,
    '每次调用需人工确认(第三方默认高危)',
    `参数:${(m.tool?.params ?? []).map((p) => p.name).join('、') || '无'}`,
    m.author ? `作者:${m.author}` : '',
    m.homepage ? `主页:${m.homepage}` : ''
  ].filter(Boolean)
}

export function registerSkillHandlers(): void {
  ipcMain.handle('cs:skill:list', () => {
    try {
      return { ok: true as const, skills: listSkillPackages() }
    } catch (err) {
      return { ok: false as const, error: err instanceof Error ? err.message : String(err) }
    }
  })

  // 安装前检查:读取目录 skill.json 并返回能力摘要(不落库)
  ipcMain.handle('cs:skill:inspect', async (_e, dir: string) => {
    if (!dir) return { ok: false as const, error: '缺少目录' }
    try {
      const raw = await readFile(join(dir, 'skill.json'), 'utf-8')
      const r = parseManifest(raw)
      if (!r.ok) return { ok: false as const, error: r.error }
      const m = r.manifest
      // 命名冲突检查(内置/自定义工具/已安装)
      const customNames = new Set(listCustomTools().map((t) => t.name))
      const builtinNames = new Set(ALL_TOOLS.map((t) => t.name))
      if (builtinNames.has(m.name) || customNames.has(m.name)) {
        return { ok: false as const, error: `工具名 ${m.name} 与内置/自定义工具冲突` }
      }
      const info: SkillInstallInfo = {
        name: m.name,
        version: m.version,
        kind: m.kind,
        description: m.description,
        author: m.author,
        homepage: m.homepage,
        capabilities: capabilitiesOf(m),
        hash: hashSkillManifest(m)
      }
      return { ok: true as const, info }
    } catch (err) {
      return { ok: false as const, error: err instanceof Error ? err.message : String(err) }
    }
  })

  // 确认后安装(再次校验 + 落库;变更即时生效)
  ipcMain.handle('cs:skill:install', async (_e, dir: string) => {
    if (!dir) return { ok: false as const, error: '缺少目录' }
    try {
      const raw = await readFile(join(dir, 'skill.json'), 'utf-8')
      const r = parseManifest(raw)
      if (!r.ok) return { ok: false as const, error: r.error }
      const m = r.manifest
      const saved = saveSkillPackage({
        name: m.name,
        version: m.version,
        kind: m.kind,
        description: m.description,
        author: m.author,
        manifest: m,
        hash: hashSkillManifest(m)
      })
      if (!saved.ok) return { ok: false as const, error: saved.error }
      return { ok: true as const }
    } catch (err) {
      return { ok: false as const, error: err instanceof Error ? err.message : String(err) }
    }
  })

  ipcMain.handle('cs:skill:remove', (_e, id: number) => {
    if (!Number.isInteger(id)) return { ok: false as const, error: '参数错误' }
    try {
      if (!removeSkillPackage(id)) return { ok: false as const, error: '技能不存在' }
      return { ok: true as const }
    } catch (err) {
      return { ok: false as const, error: err instanceof Error ? err.message : String(err) }
    }
  })

  ipcMain.handle('cs:skill:toggle', (_e, id: number, enabled: boolean) => {
    if (!Number.isInteger(id)) return { ok: false as const, error: '参数错误' }
    try {
      if (!toggleSkillPackage(id, !!enabled)) return { ok: false as const, error: '技能不存在' }
      return { ok: true as const }
    } catch (err) {
      return { ok: false as const, error: err instanceof Error ? err.message : String(err) }
    }
  })
}
