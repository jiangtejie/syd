import { contextBridge, ipcRenderer } from 'electron'
import { electronAPI } from '@electron-toolkit/preload'
import type {
  KeySource,
  DbChangedPayload,
  AiGenOptions,
  ChatMessage,
  ReplyCandidate,
  SendResult,
  SendStatusInfo,
  SendOverview,
  OpsStats,
  MessageCursor
} from '../shared/types'

// Custom APIs for renderer
const api = {
  cs: {
    keyStore: {
      getStatus: (wxid: string) => ipcRenderer.invoke('cs:key:getStatus', wxid),
      list: () => ipcRenderer.invoke('cs:key:list'),
      importKey: (wxid: string, keyHex: string, source: KeySource, dbPath?: string) =>
        ipcRenderer.invoke('cs:key:import', wxid, keyHex, source, dbPath),
      test: (wxid: string) => ipcRenderer.invoke('cs:key:test', wxid),
      refresh: (wxid: string) => ipcRenderer.invoke('cs:key:refresh', wxid)
    },
    wx: {
      connect: (wxid: string) => ipcRenderer.invoke('cs:wx:connect', wxid),
      getSessions: (wxid: string) => ipcRenderer.invoke('cs:wx:getSessions', wxid),
      getMessages: (wxid: string, sessionId: string, limit?: number, before?: MessageCursor) =>
        ipcRenderer.invoke('cs:wx:getMessages', wxid, sessionId, limit, before),
      getMessagesSince: (wxid: string, sessionId: string, sinceSortSeq: number) =>
        ipcRenderer.invoke('cs:wx:getMessagesSince', wxid, sessionId, sinceSortSeq),
      getRedEnvelopeStatuses: (wxid: string, sessionId: string) =>
        ipcRenderer.invoke('cs:wx:getRedEnvelopeStatuses', wxid, sessionId),
      getAvatar: (
        wxid: string,
        username: string,
        localOnly?: boolean
      ): Promise<{ ok: boolean; url?: string; error?: string }> =>
        ipcRenderer.invoke('cs:wx:getAvatar', wxid, username, localOnly),
      startWatch: (wxid: string) => ipcRenderer.invoke('cs:wx:startWatch', wxid),
      stopWatch: (wxid: string) => ipcRenderer.invoke('cs:wx:stopWatch', wxid),
      opsStats: (
        wxid: string,
        rangeDays?: number
      ): Promise<{ ok: boolean; stats?: OpsStats; error?: string }> =>
        ipcRenderer.invoke('cs:wx:opsStats', wxid, rangeDays),
      onDbChanged: (callback: (payload: DbChangedPayload) => void) => {
        const listener = (_e: Electron.IpcRendererEvent, payload: DbChangedPayload): void =>
          callback(payload)
        ipcRenderer.on('cs:wx:dbChanged', listener)
        return () => ipcRenderer.removeListener('cs:wx:dbChanged', listener)
      }
    },
    ai: {
      generateReply: (
        sessionName: string,
        messages: ChatMessage[],
        opts?: AiGenOptions
      ): Promise<{ ok: boolean; candidates?: ReplyCandidate[]; llm?: boolean; error?: string }> =>
        ipcRenderer.invoke('cs:ai:generateReply', sessionName, messages, opts)
    },
    reply: {
      sendText: (args: {
        wxid: string
        sessionId: string
        targetName: string
        text: string
        source?: string
      }): Promise<{ ok: boolean; result?: SendResult; error?: string }> =>
        ipcRenderer.invoke('cs:reply:sendText', args),
      getSendStatus: (): Promise<SendStatusInfo> => ipcRenderer.invoke('cs:reply:getSendStatus'),
      stats7d: (): Promise<Array<{ day: string; sent: number; failed: number }>> =>
        ipcRenderer.invoke('cs:reply:stats7d'),
      overview: (): Promise<{ ok: boolean; data?: SendOverview; error?: string }> =>
        ipcRenderer.invoke('cs:reply:overview'),
      resetCircuit: (): Promise<{ ok: boolean }> => ipcRenderer.invoke('cs:reply:resetCircuit')
    },
    config: {
      getAll: (): Promise<Record<string, string>> => ipcRenderer.invoke('cs:config:getAll'),
      set: (key: string, value: string): Promise<{ ok: boolean; error?: string }> =>
        ipcRenderer.invoke('cs:config:set', key, value),
      cachePath: (): Promise<{
        ok: boolean
        path?: string
        defaultPath?: string
        isDefault?: boolean
      }> => ipcRenderer.invoke('cs:config:cachePath')
    },
    dialog: {
      pickDirectory: (title?: string, defaultPath?: string): Promise<{ ok: boolean; path?: string }> =>
        ipcRenderer.invoke('cs:dialog:pickDirectory', title, defaultPath)
    },
    media: {
      decryptImage: (opts: {
        wxid: string
        imageMd5: string
        kind?: 'orig' | 'thumb' | 'hd'
        dbPath?: string
      }): Promise<{ ok: boolean; url?: string; ext?: string; error?: string }> =>
        ipcRenderer.invoke('cs:media:decryptImage', opts),
      decryptVideo: (opts: {
        wxid: string
        videoMd5: string
        dbPath?: string
      }): Promise<{ ok: boolean; url?: string; error?: string }> =>
        ipcRenderer.invoke('cs:media:decryptVideo', opts),
      testImageDecrypt: (
        wxid: string,
        dbPath?: string
      ): Promise<{ ok: boolean; url?: string; ext?: string; error?: string }> =>
        ipcRenderer.invoke('cs:media:testImageDecrypt', wxid, dbPath)
    },
    issue: {
      list: (wxid: string): Promise<{ ok: boolean; issues?: unknown[]; error?: string }> =>
        ipcRenderer.invoke('cs:issue:list', wxid),
      analyze: (wxid: string): Promise<{ ok: boolean; error?: string; state?: unknown }> =>
        ipcRenderer.invoke('cs:issue:analyze', wxid),
      state: (wxid: string): Promise<{ ok: boolean; state?: unknown }> =>
        ipcRenderer.invoke('cs:issue:state', wxid),
      clear: (wxid: string): Promise<{ ok: boolean; error?: string }> =>
        ipcRenderer.invoke('cs:issue:clear', wxid),
      setStatus: (
        id: number,
        status: string
      ): Promise<{ ok: boolean; error?: string }> =>
        ipcRenderer.invoke('cs:issue:setStatus', id, status),
      detail: (id: number): Promise<{ ok: boolean; issue?: unknown; error?: string }> =>
        ipcRenderer.invoke('cs:issue:detail', id),
      typeCounts: (wxid: string): Promise<{ ok: boolean; counts?: unknown[]; error?: string }> =>
        ipcRenderer.invoke('cs:issue:typeCounts', wxid)
    },
    app: {
      /** 菜单/托盘等触发的页面导航（如 Ctrl+, 打开设置） */
      onNavigate: (callback: (page: string) => void) => {
        const listener = (_e: Electron.IpcRendererEvent, page: string): void => callback(page)
        ipcRenderer.on('app:navigate', listener)
        return () => ipcRenderer.removeListener('app:navigate', listener)
      },
      info: (): Promise<{
        version: string
        electron: string
        chrome: string
        node: string
        platform: string
      }> => ipcRenderer.invoke('cs:app:info'),
      getAutoLaunch: (): Promise<{ ok: boolean; enabled?: boolean }> =>
        ipcRenderer.invoke('cs:app:getAutoLaunch'),
      setAutoLaunch: (enabled: boolean): Promise<{ ok: boolean; enabled?: boolean }> =>
        ipcRenderer.invoke('cs:app:setAutoLaunch', enabled),
      dataStats: (): Promise<{
        ok: boolean
        dbBytes?: number
        cacheBytes?: number
        cachePath?: string
      }> => ipcRenderer.invoke('cs:app:dataStats'),
      clearCache: (): Promise<{ ok: boolean; error?: string }> =>
        ipcRenderer.invoke('cs:app:clearCache')
    }
  }
}

// Use `contextBridge` APIs to expose Electron APIs to
// renderer only if context isolation is enabled, otherwise
// just add to the DOM global.
if (process.contextIsolated) {
  try {
    contextBridge.exposeInMainWorld('electron', electronAPI)
    contextBridge.exposeInMainWorld('api', api)
  } catch (error) {
    console.error(error)
  }
} else {
  // @ts-ignore (define in dts)
  window.electron = electronAPI
  // @ts-ignore (define in dts)
  window.api = api
}
