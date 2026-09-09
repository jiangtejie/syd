import { ipcMain } from 'electron'
import * as keyStore from '../services/keyStoreService'
import type { KeySource } from '../../shared/types'

export function registerKeyStoreHandlers(): void {
  ipcMain.handle('cs:key:getStatus', (_e, wxid: string) => keyStore.getKeyStatus(wxid))

  ipcMain.handle('cs:key:list', () => keyStore.listAccounts())

  ipcMain.handle(
    'cs:key:import',
    (_e, wxid: string, keyHex: string, source: KeySource, dbPath?: string) =>
      keyStore.importKey(wxid, keyHex, source, dbPath ?? '')
  )

  ipcMain.handle('cs:key:test', (_e, wxid: string) => keyStore.testKey(wxid))
}
