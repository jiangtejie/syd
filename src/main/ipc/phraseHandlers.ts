import { ipcMain } from 'electron'
import { listPhrases, savePhrase, removePhrase, bumpPhraseUsage } from '../db/repos/phraseRepo'
import type { PhraseInput } from '../../shared/types'

/**
 * 话术库 IPC（发送栏快速插入）。
 * cs:phrase:list / save / remove / use
 */
export function registerPhraseHandlers(): void {
  ipcMain.handle('cs:phrase:list', (_e, q?: string) => {
    try {
      return { ok: true as const, phrases: listPhrases(q ?? '') }
    } catch (err) {
      return { ok: false as const, error: err instanceof Error ? err.message : String(err) }
    }
  })

  ipcMain.handle('cs:phrase:save', (_e, input: PhraseInput) =>
    savePhrase(input ?? ({} as PhraseInput))
  )

  ipcMain.handle('cs:phrase:remove', (_e, id: number) => {
    if (!Number.isInteger(id)) return { ok: false as const, error: '参数错误' }
    try {
      return removePhrase(id) ? { ok: true as const } : { ok: false as const, error: '话术不存在' }
    } catch (err) {
      return { ok: false as const, error: err instanceof Error ? err.message : String(err) }
    }
  })

  ipcMain.handle('cs:phrase:use', (_e, id: number) => {
    if (Number.isInteger(id)) bumpPhraseUsage(id)
    return { ok: true as const }
  })
}
