import { app } from 'electron'
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { getConfig, setConfig } from '../../../db/repos/config'
import type { WbSkillInfo } from './types'

/**
 * 轻量 SKILL.md(Claude Code 风格,无代码执行)。
 * - 目录:userData/skills/<name>/SKILL.md,frontmatter 必填 name/description;
 * - 校验:纯 markdown、≤32KB、frontmatter 合法、目录名安全;
 * - 启用集存 config(`wb.skills.enabled`,逗号名);注入量 ≤3 个 / 全文 ≤6k;
 * - 无市场/无安装向导:用户直接把目录放进去即可(设置页可打开目录)。
 */

const MAX_SKILL_BYTES = 32 * 1024
const MAX_ENABLED = 3
const MAX_INJECT_CHARS = 6000
const SKILL_DIR = 'skills'

export function skillsRoot(): string {
  return join(app.getPath('userData'), SKILL_DIR)
}

function safeDirName(name: string): boolean {
  return /^[A-Za-z0-9_\-\u4e00-\u9fa5]{1,64}$/.test(name) && name !== '.' && name !== '..'
}

interface Frontmatter {
  name: string
  description: string
}

/** 极简 YAML frontmatter 解析(仅 name/description 单行值) */
function parseFrontmatter(md: string): Frontmatter | null {
  const m = /^---\r?\n([\s\S]*?)\r?\n---/.exec(md)
  if (!m) return null
  const out: Record<string, string> = {}
  for (const line of m[1].split(/\r?\n/)) {
    const kv = /^([A-Za-z][A-Za-z0-9_-]*):\s*(.*)$/.exec(line.trim())
    if (kv) out[kv[1]] = kv[2].trim().replace(/^['"]|['"]$/g, '')
  }
  if (!out.name || !out.description) return null
  return { name: out.name, description: out.description }
}

function enabledNames(): Set<string> {
  const raw = (getConfig('wb.skills.enabled') ?? '').trim()
  return new Set(
    raw
      ? raw
          .split(',')
          .map((s) => s.trim())
          .filter(Boolean)
      : []
  )
}

export function listSkills(): WbSkillInfo[] {
  const root = skillsRoot()
  if (!existsSync(root)) return []
  const enabled = enabledNames()
  const out: WbSkillInfo[] = []
  let dirs: string[] = []
  try {
    dirs = readdirSync(root, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name)
  } catch {
    return []
  }
  for (const dirName of dirs.sort()) {
    if (!safeDirName(dirName)) continue
    const file = join(root, dirName, 'SKILL.md')
    if (!existsSync(file)) continue
    try {
      const st = statSync(file)
      if (!st.isFile() || st.size > MAX_SKILL_BYTES) continue
      const md = readFileSync(file, 'utf8')
      const fm = parseFrontmatter(md)
      if (!fm) continue
      out.push({
        name: fm.name,
        description: fm.description,
        dirName,
        sizeBytes: st.size,
        enabled: enabled.has(fm.name)
      })
    } catch {
      /* 单个损坏文件跳过 */
    }
  }
  return out
}

export function setSkillEnabled(name: string, enabled: boolean): boolean {
  const list = listSkills()
  if (!list.some((s) => s.name === name)) return false
  const set = enabledNames()
  if (enabled) set.add(name)
  else set.delete(name)
  setConfig('wb.skills.enabled', [...set].sort().join(','))
  return true
}

/** 读取技能正文(校验通过后) */
function readSkillBody(info: WbSkillInfo): string {
  const file = join(skillsRoot(), info.dirName, 'SKILL.md')
  const md = readFileSync(file, 'utf8')
  return md.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n/, '')
}

/** 目录行(未启用也展示,便于模型知道存在什么) */
export function skillsCatalogText(): string {
  const list = listSkills()
  if (list.length === 0) return ''
  return list
    .map((s) => `- [${s.enabled ? '启用' : '未启用'}] ${s.name}:${s.description}`)
    .join('\n')
}

/** 启用技能正文注入(≤3 个,总量 ≤6k) */
export function skillsInjectionText(): string {
  const list = listSkills()
    .filter((s) => s.enabled)
    .slice(0, MAX_ENABLED)
  if (list.length === 0) return ''
  const parts: string[] = []
  let total = 0
  for (const s of list) {
    const body = readSkillBody(s).trim()
    if (!body) continue
    const piece = body.length > 2400 ? `${body.slice(0, 2400)}\n…(超长已截断)` : body
    if (total + piece.length > MAX_INJECT_CHARS) break
    parts.push(`【技能:${s.name}】\n${piece}`)
    total += piece.length
  }
  if (parts.length === 0) return ''
  return `# 业务技能(按此口径执行;仅相关内容时使用)\n${parts.join('\n\n')}`
}

/* ══════════ 内置技能(首次启动自动种子并默认启用) ══════════ */

const SEEDED_KEY = 'wb.skills.seeded'

/** 内置「回复排版」技能:教模型用客户端富文本组件组织回答,避免回复形式单一 */
const BUILTIN_REPLY_FORMAT = {
  dirName: 'reply-format',
  name: '回复排版',
  description: '用 Markdown 富文本组织回答:表格/清单/告警块/代码块,排版克制清晰',
  md: `---
name: 回复排版
description: 用 Markdown 富文本组织回答:表格/清单/告警块/代码块,排版克制清晰
---

# 回复排版规范(富文本组件)

客户端已支持以下 Markdown 富文本组件。根据内容选择合适的结构,不要一律输出大段文字:

1. 表格:需要对比或列举多维数据时(如各群问题量、KPI、状态清单、口径对比),先给一句结论,再用表格呈现;表头尽量简短,列数不要超过 6 列。
2. 任务清单:给「待办 / 建议动作 / 跟进事项」时,用勾选列表,如:
   - [ ] 事项一
   - [x] 已完成事项
3. 告警块:需要强调的信息用 GitHub 风格告警(单独成段):
   > [!NOTE] 补充说明
   > [!TIP] 建议做法
   > [!IMPORTANT] 必须注意/关键结论
   > [!WARNING] 风险与提醒
   > [!DANGER] 阻断性/危险事项
4. 代码块/行内代码:文件名、命令、JSON、SQL、传参示例等用 \`\`\` 或 \` 包裹;中文正文叙述不要用代码块。
5. 引用:引用客户原话、口径依据、SKILL 原文时用 > 引用,并标注来源。
6. 标题与列表:结论先行,善用 ##/### 分节与有序/无序列表;每个小节只讲一件事。

排版原则:轻量、克制。信息很少时一个自然段即可;不要为了“看起来丰富”堆砌组件,表格里不要放废话,告警块不要连续使用。`
}

/** 首次启动种子内置技能(用户已有自建技能则不打扰;执行一次后不再写) */
export function ensureBuiltinSkillSeeded(): void {
  try {
    if (getConfig(SEEDED_KEY) === '1') return
    const existing = listSkills()
    if (existing.length > 0) {
      setConfig(SEEDED_KEY, '1')
      return
    }
    const dir = join(skillsRoot(), BUILTIN_REPLY_FORMAT.dirName)
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'SKILL.md'), BUILTIN_REPLY_FORMAT.md, 'utf8')
    // 默认启用(追加进启用集)
    const enabled = enabledNames()
    enabled.add(BUILTIN_REPLY_FORMAT.name)
    setConfig('wb.skills.enabled', [...enabled].sort().join(','))
    setConfig(SEEDED_KEY, '1')
  } catch {
    /* 种子失败不阻塞(下次启动重试) */
  }
}
