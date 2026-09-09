import { BrowserWindow } from 'electron'
import type { GrowthProgressPayload } from '../../../shared/growth'

/** 采集/入库进度推送(渲染层增长页订阅 cs:growth:progress) */
export function broadcastGrowth(payload: GrowthProgressPayload): void {
  for (const w of BrowserWindow.getAllWindows()) {
    w.webContents.send('cs:growth:progress', payload)
  }
}
