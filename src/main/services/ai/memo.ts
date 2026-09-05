import { getConfig, setConfig } from '../../db/repos/config'

/**
 * 跨会话「运营备忘」:用户维护的动态事实(每行一条),随每轮 system 注入。
 * 与静态 SKILL/人设并存:备忘是「最新事实」,冲突时以备忘/最新口径为准。
 */

export const WB_MEMO_KEY = 'wb.memo.notes'

export function readMemoNotes(): string {
  return (getConfig(WB_MEMO_KEY) ?? '').trim()
}

export function writeMemoNotes(notes: string): void {
  setConfig(WB_MEMO_KEY, String(notes ?? ''))
}

/** 注入用的 system 块(无内容返回空串;超长截断) */
export function memoSystemBlock(cap = 1600): string {
  const notes = readMemoNotes()
  if (!notes) return ''
  const body = notes.length > cap ? `${notes.slice(0, cap)}\n…(备忘过长已截断)` : notes
  return `# 运营备忘(跨会话动态事实,与提问相关时引用;与守则/最新口径冲突时以最新备忘为准)\n${body}`
}
