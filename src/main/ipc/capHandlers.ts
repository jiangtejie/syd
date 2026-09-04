import { ipcMain } from 'electron'
import { getConfig, setConfig } from '../db/repos/config'
import { SOFTWARE_CAPS, isCapDisabled } from '../services/ai/cap/registry'

/** 能力分层注册表 IPC(技能页只读展示 + 内置软件能力停用开关)。 */

export function registerCapHandlers(): void {
  // 内置软件能力(L2)清单 + 停用状态
  ipcMain.handle('cs:cap:software', () => {
    const rows = SOFTWARE_CAPS.map((c) => ({
      name: c.name,
      oneLine: c.oneLine,
      when: c.when,
      needsWx: c.needsWx,
      disabled: isCapDisabled(c.name)
    }))
    return { ok: true as const, caps: rows }
  })

  // 停用/启用某项内置软件能力(config cap.disable = 逗号列表,增量更新)
  ipcMain.handle('cs:cap:setSoftware', (_e, name: string, enabled: boolean) => {
    if (typeof name !== 'string' || !SOFTWARE_CAPS.some((c) => c.name === name)) {
      return { ok: false as const, error: '能力不存在' }
    }
    const cur = new Set(
      (getConfig('cap.disable') ?? '')
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean)
    )
    if (enabled) cur.delete(name)
    else cur.add(name)
    setConfig('cap.disable', [...cur].sort().join(','))
    return { ok: true as const }
  })
}
