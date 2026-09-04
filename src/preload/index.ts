import { contextBridge, ipcRenderer } from 'electron'
import { electronAPI } from '@electron-toolkit/preload'
import type {
  KeySource,
  DbChangedPayload,
  AiGenOptions,
  AiAgent,
  AiAgentInput,
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
      contactNames: (
        wxid: string,
        usernames: string[]
      ): Promise<{ ok: boolean; names?: Record<string, string>; error?: string }> =>
        ipcRenderer.invoke('cs:wx:contactNames', wxid, usernames),
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
        wxid: string,
        sessionId: string,
        sessionName: string,
        messages: ChatMessage[],
        opts?: AiGenOptions
      ): Promise<{
        ok: boolean
        candidates?: ReplyCandidate[]
        llm?: boolean
        error?: string
        toolsUsed?: string[]
      }> => ipcRenderer.invoke('cs:ai:generateReply', wxid, sessionId, sessionName, messages, opts),
      test: (input?: {
        baseUrl?: string
        apiKey?: string
        model?: string
        timeoutMs?: number
      }): Promise<{ ok: boolean; latencyMs?: number; error?: string }> =>
        ipcRenderer.invoke('cs:ai:test', input),
      models: (input?: {
        baseUrl?: string
        apiKey?: string
        timeoutMs?: number
      }): Promise<{ ok: boolean; models?: string[]; error?: string }> =>
        ipcRenderer.invoke('cs:ai:models', input)
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
      pickDirectory: (
        title?: string,
        defaultPath?: string
      ): Promise<{ ok: boolean; path?: string }> =>
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
        ipcRenderer.invoke('cs:media:testImageDecrypt', wxid, dbPath),
      resolveEmoji: (
        wxid: string,
        input: { md5?: string; productId?: string; cdnUrl?: string }
      ): Promise<{ ok: boolean; url?: string; error?: string }> =>
        ipcRenderer.invoke('cs:media:resolveEmoji', wxid, input)
    },
    issue: {
      list: (wxid: string): Promise<{ ok: boolean; issues?: unknown[]; error?: string }> =>
        ipcRenderer.invoke('cs:issue:list', wxid),
      analyze: (wxid: string): Promise<{ ok: boolean; error?: string; state?: unknown }> =>
        ipcRenderer.invoke('cs:issue:analyze', wxid),
      analyzeGroup: (
        wxid: string,
        groupUsername: string,
        groupName?: string,
        opts?: { days?: number; force?: boolean; reset?: boolean }
      ): Promise<{
        ok: boolean
        error?: string
        skipped?: boolean
        method?: 'llm' | 'rule'
        count?: number
        lastAt?: number
      }> => ipcRenderer.invoke('cs:issue:analyzeGroup', wxid, groupUsername, groupName, opts),
      listGroup: (
        wxid: string,
        groupUsername: string
      ): Promise<{ ok: boolean; issues?: unknown[]; error?: string }> =>
        ipcRenderer.invoke('cs:issue:listGroup', wxid, groupUsername),
      state: (wxid: string): Promise<{ ok: boolean; state?: unknown }> =>
        ipcRenderer.invoke('cs:issue:state', wxid),
      clear: (wxid: string): Promise<{ ok: boolean; error?: string }> =>
        ipcRenderer.invoke('cs:issue:clear', wxid),
      clearGroup: (wxid: string, groupUsername: string): Promise<{ ok: boolean; error?: string }> =>
        ipcRenderer.invoke('cs:issue:clearGroup', wxid, groupUsername),
      setStatus: (id: number, status: string): Promise<{ ok: boolean; error?: string }> =>
        ipcRenderer.invoke('cs:issue:setStatus', id, status),
      assign: (id: number, username: string | null): Promise<{ ok: boolean; error?: string }> =>
        ipcRenderer.invoke('cs:issue:assign', id, username),
      confirmDoubt: (id: number): Promise<{ ok: boolean; error?: string }> =>
        ipcRenderer.invoke('cs:issue:confirmDoubt', id),
      detail: (id: number): Promise<{ ok: boolean; issue?: unknown; error?: string }> =>
        ipcRenderer.invoke('cs:issue:detail', id),
      typeCounts: (wxid: string): Promise<{ ok: boolean; counts?: unknown[]; error?: string }> =>
        ipcRenderer.invoke('cs:issue:typeCounts', wxid),
      groupBadges: (
        wxid: string
      ): Promise<{ ok: boolean; badges?: Record<string, number>; error?: string }> =>
        ipcRenderer.invoke('cs:issue:groupBadges', wxid),
      onChanged: (
        callback: (payload: {
          at?: number
          wxid?: string
          added?: number
          escalate?: number
        }) => void
      ): (() => void) => {
        const listener = (
          _e: Electron.IpcRendererEvent,
          payload: { at?: number; wxid?: string; added?: number; escalate?: number }
        ): void => callback(payload)
        ipcRenderer.on('cs:issue:changed', listener)
        return () => ipcRenderer.removeListener('cs:issue:changed', listener)
      }
    },
    team: {
      list: (accountWxid: string): Promise<{ ok: boolean; members?: unknown[]; error?: string }> =>
        ipcRenderer.invoke('cs:team:list', accountWxid),
      save: (
        accountWxid: string,
        username: string,
        label?: string
      ): Promise<{ ok: boolean; error?: string }> =>
        ipcRenderer.invoke('cs:team:save', accountWxid, username, label),
      remove: (accountWxid: string, username: string): Promise<{ ok: boolean; error?: string }> =>
        ipcRenderer.invoke('cs:team:remove', accountWxid, username)
    },
    aiChat: {
      listChats: (wxid: string): Promise<{ ok: boolean; chats?: unknown[]; error?: string }> =>
        ipcRenderer.invoke('cs:aichat:listChats', wxid),
      messages: (
        sessionId: number
      ): Promise<{ ok: boolean; messages?: unknown[]; error?: string }> =>
        ipcRenderer.invoke('cs:aichat:messages', sessionId),
      renameChat: (sessionId: number, title: string): Promise<{ ok: boolean; error?: string }> =>
        ipcRenderer.invoke('cs:aichat:renameChat', sessionId, title),
      removeChat: (sessionId: number): Promise<{ ok: boolean; error?: string }> =>
        ipcRenderer.invoke('cs:aichat:removeChat', sessionId),
      clearChat: (sessionId: number): Promise<{ ok: boolean; error?: string }> =>
        ipcRenderer.invoke('cs:aichat:clearChat', sessionId),
      send: (input: {
        wxid: string
        chatId?: number
        agentId?: string | null
        text: string
      }): Promise<{ ok: boolean; chatId?: number; error?: string }> =>
        ipcRenderer.invoke('cs:aichat:send', input),
      stop: (wxid: string, sessionId: number): Promise<{ ok: boolean }> =>
        ipcRenderer.invoke('cs:aichat:stop', wxid, sessionId),
      retry: (
        wxid: string,
        sessionId: number,
        agentId?: string | null
      ): Promise<{ ok: boolean; chatId?: number; error?: string }> =>
        ipcRenderer.invoke('cs:aichat:retry', wxid, sessionId, agentId),
      confirmTool: (runId: string, ok: boolean): Promise<{ ok: boolean; error?: string }> =>
        ipcRenderer.invoke('cs:aichat:confirmTool', runId, ok),
      setAgent: (
        sessionId: number,
        agentId: string | null
      ): Promise<{ ok: boolean; error?: string }> =>
        ipcRenderer.invoke('cs:aichat:setAgent', sessionId, agentId),
      onEvent: (callback: (evt: unknown) => void): (() => void) => {
        const listener = (_e: Electron.IpcRendererEvent, payload: unknown): void =>
          callback(payload)
        ipcRenderer.on('ai:chat', listener)
        return () => ipcRenderer.removeListener('ai:chat', listener)
      }
    },
    export: {
      chat: (
        wxid: string,
        opts: {
          targets: Array<{ username: string; displayName: string }>
          startMs?: number
          endMs?: number
          format: 'txt' | 'html' | 'json'
          folder: string
        }
      ): Promise<{
        ok: boolean
        folder?: string
        files?: Array<{ name: string; msgCount: number }>
        error?: string
      }> => ipcRenderer.invoke('cs:export:chat', wxid, opts),
      business: (
        wxid: string,
        folder: string
      ): Promise<{ ok: boolean; folder?: string; name?: string; error?: string }> =>
        ipcRenderer.invoke('cs:export:business', wxid, folder),
      openFolder: (folder: string): Promise<{ ok: boolean; error?: string }> =>
        ipcRenderer.invoke('cs:export:openFolder', folder),
      writeFile: (
        folder: string,
        name: string,
        content: string
      ): Promise<{ ok: boolean; path?: string; error?: string }> =>
        ipcRenderer.invoke('cs:export:writeFile', folder, name, content),
      onProgress: (callback: (evt: unknown) => void): (() => void) => {
        const listener = (_e: Electron.IpcRendererEvent, evt: unknown): void => callback(evt)
        ipcRenderer.on('cs:export:progress', listener)
        return () => ipcRenderer.removeListener('cs:export:progress', listener)
      }
    },
    agent: {
      list: (): Promise<{
        ok: boolean
        agents?: AiAgent[]
        defaultId?: string | null
        error?: string
      }> => ipcRenderer.invoke('cs:agent:list'),
      save: (input: AiAgentInput): Promise<{ ok: boolean; agent?: AiAgent; error?: string }> =>
        ipcRenderer.invoke('cs:agent:save', input),
      remove: (id: string): Promise<{ ok: boolean; error?: string }> =>
        ipcRenderer.invoke('cs:agent:remove', id),
      setDefault: (id: string): Promise<{ ok: boolean; error?: string }> =>
        ipcRenderer.invoke('cs:agent:setDefault', id)
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
