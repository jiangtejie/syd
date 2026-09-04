import { BrowserWindow } from 'electron'
import type { WbEvent } from './types'

/** 工作台事件通道(ai:wb);payload 附带 sessionId,渲染侧按会话过滤。 */

export function emitWorkbenchEvent(sessionId: number, evt: Omit<WbEvent, 'sessionId'>): void {
  const payload: WbEvent = { sessionId, ...evt }
  for (const win of BrowserWindow.getAllWindows()) {
    win.webContents.send('ai:wb', payload)
  }
}
