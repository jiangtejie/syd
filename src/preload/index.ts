import { contextBridge, ipcRenderer } from 'electron'
import { electronAPI } from '@electron-toolkit/preload'
import type {
  AccountReadiness,
  OnboardReport,
  PreloadApi,
  Result,
  WarmupReport
} from '../shared/api'
import type { ImageDegradedReason, ImageKind, ImageTier } from '../shared/imageTier'
import type { FfmpegStatus } from '../shared/ffmpeg'
import type { AiRunSummaryView } from '../shared/api'
import type { CustomerStored } from '../shared/customerProfile'
import type {
  ChatMsgItem,
  ChatSessionItem,
  FeedbackAnalysisState,
  DeriveImageKeysResult,
  LarkBaseStatus,
  LarkBaseVerify,
  LarkDigestConfig,
  LarkEvidenceConfig,
  LarkEvidenceSetup,
  LarkPersonConfig,
  LarkSystemUpgrade,
  LarkPullResult,
  LarkSyncOut,
  FeedbackIssue,
  FeedbackIssueDetail,
  ImAuditEntry,
  ImChannelAccount,
  ReportJobInfo,
  ReportRunInfo,
  TeamMemberInfo,
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
// 对着共享接口编译：实现漏改/声明漏加都会直接编译失败（真源见 src/shared/api.ts）
const api: PreloadApi = {
  cs: {
    keyStore: {
      getStatus: (wxid: string) => ipcRenderer.invoke('cs:key:getStatus', wxid),
      list: () => ipcRenderer.invoke('cs:key:list'),
      importKey: (wxid: string, keyHex: string, source: KeySource, dbPath?: string) =>
        ipcRenderer.invoke('cs:key:import', wxid, keyHex, source, dbPath),
      test: (wxid: string) => ipcRenderer.invoke('cs:key:test', wxid),
      importKeyFile: (wxid: string, filePath: string, dbPath?: string) =>
        ipcRenderer.invoke('cs:key:importFile', wxid, filePath, dbPath),
      clearKeyRing: (wxid: string) => ipcRenderer.invoke('cs:key:clearKeyRing', wxid)
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
      opsStats: (
        wxid: string,
        rangeDays?: number
      ): Promise<{ ok: boolean; stats?: OpsStats; error?: string }> =>
        ipcRenderer.invoke('cs:wx:opsStats', wxid, rangeDays),
      /** 图片密钥本地推导 + AES 校验（不依赖原生组件） */
      deriveImageKeys: (wxid: string, knownAesKey?: string): Promise<DeriveImageKeysResult> =>
        ipcRenderer.invoke('cs:wx:deriveImageKeys', wxid, knownAesKey),
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
        ipcRenderer.invoke('cs:ai:models', input),
      runSummary: (
        days?: number
      ): Promise<{ ok: boolean; summary?: AiRunSummaryView; error?: string }> =>
        ipcRenderer.invoke('cs:ai:runSummary', days)
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
      sendFile: (args: {
        wxid: string
        sessionId: string
        targetName: string
        path: string
        kind: 'image' | 'file'
        source?: string
      }): Promise<{ ok: boolean; result?: SendResult; error?: string }> =>
        ipcRenderer.invoke('cs:reply:sendFile', args),
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
        ipcRenderer.invoke('cs:dialog:pickDirectory', title, defaultPath),
      pickFiles: (opts?: {
        title?: string
        multi?: boolean
        filters?: Array<{ name: string; extensions: string[] }>
      }): Promise<{ ok: boolean; paths?: string[] }> =>
        ipcRenderer.invoke('cs:dialog:pickFiles', opts ?? {})
    },
    logs: {
      recent: (opts?: {
        minLevel?: 'debug' | 'info' | 'warn' | 'error'
        scope?: string
        query?: string
        sinceMs?: number
        max?: number
      }): Promise<{
        ok: boolean
        entries?: Array<{ ts: number; level: string; scope: string; msg: string }>
        error?: string
      }> => ipcRenderer.invoke('cs:logs:recent', opts ?? {}),
      openFolder: (): Promise<{ ok: boolean; error?: string }> =>
        ipcRenderer.invoke('cs:logs:openFolder'),
      clear: (): Promise<{ ok: boolean; removed?: number; error?: string }> =>
        ipcRenderer.invoke('cs:logs:clear'),
      applyConfig: (): Promise<{
        ok: boolean
        keepDays?: number
        ringMax?: number
        error?: string
      }> => ipcRenderer.invoke('cs:logs:applyConfig')
    },
    crypto: {
      discover: (): Promise<{
        ok: boolean
        accounts?: Array<{ accountId: string; wxid: string; dir: string }>
        error?: string
      }> => ipcRenderer.invoke('cs:crypto:discover'),
      readiness: (
        wxid: string
      ): Promise<{ ok: boolean; report?: AccountReadiness; error?: string }> =>
        ipcRenderer.invoke('cs:crypto:readiness', wxid),
      warmup: (wxid: string): Promise<{ ok: boolean; report?: WarmupReport; error?: string }> =>
        ipcRenderer.invoke('cs:crypto:warmup', wxid),
      onboard: (opts?: {
        wxid?: string
        dbPath?: string
        keyHex?: string
        connect?: boolean
      }): Promise<{
        ok: boolean
        report?: OnboardReport
        connected?: { ok: boolean; error?: string } | null
        dbPath?: string | null
        error?: string
      }> => ipcRenderer.invoke('cs:crypto:onboard', opts)
    },
    files: {
      list: (opts?: {
        channel?: string
        accountId?: number
        limit?: number
      }): Promise<{
        ok: boolean
        files?: Array<{
          id: number
          channel: string
          accountId: number
          senderId?: string
          kind: string
          fileName: string
          bytes: number
          createdAt: number
        }>
        totals?: { count: number; bytes: number }
        accounts?: Array<{ id: number; name: string }>
        error?: string
      }> => ipcRenderer.invoke('cs:files:list', opts ?? {}),
      remove: (ids: number[]): Promise<{ ok: boolean; removed?: number; error?: string }> =>
        ipcRenderer.invoke('cs:files:remove', ids),
      reveal: (id: number): Promise<{ ok: boolean; error?: string }> =>
        ipcRenderer.invoke('cs:files:reveal', id),
      prune: (force?: boolean): Promise<{ ok: boolean; removed?: number; error?: string }> =>
        ipcRenderer.invoke('cs:files:prune', force),
      policy: (): Promise<{
        ok: boolean
        autoClean?: boolean
        keepDays?: number
        maxMB?: number
        error?: string
      }> => ipcRenderer.invoke('cs:files:policy')
    },
    media: {
      decryptImage: (opts: {
        wxid: string
        imageMd5: string
        /** best=最好可用（默认）/ orig / thumb / hd */
        kind?: ImageKind
        dbPath?: string
      }): Promise<{
        ok: boolean
        url?: string
        ext?: string
        /** 实际命中档位（回退时如实回传） */
        foundKind?: ImageTier
        /** 降级原因（如 ffmpeg 缺失），界面据此给可执行提示 */
        degradedReason?: ImageDegradedReason
        error?: string
      }> => ipcRenderer.invoke('cs:media:decryptImage', opts),
      decryptVideo: (opts: {
        wxid: string
        videoMd5: string
        dbPath?: string
      }): Promise<{ ok: boolean; url?: string; error?: string }> =>
        ipcRenderer.invoke('cs:media:decryptVideo', opts),
      testImageDecrypt: (
        wxid: string,
        dbPath?: string
      ): Promise<{
        ok: boolean
        url?: string
        ext?: string
        foundKind?: ImageTier
        degradedReason?: ImageDegradedReason
        error?: string
      }> => ipcRenderer.invoke('cs:media:testImageDecrypt', wxid, dbPath),
      // ffmpeg 解析现状：设置页据此说清「随包已就绪，你不用填」还是「正在回退」
      ffmpegStatus: (): Promise<{ ok: boolean; status?: FfmpegStatus; error?: string }> =>
        ipcRenderer.invoke('cs:media:ffmpegStatus'),
      resolveEmoji: (
        wxid: string,
        input: { md5?: string; productId?: string; cdnUrl?: string }
      ): Promise<{ ok: boolean; url?: string; error?: string }> =>
        ipcRenderer.invoke('cs:media:resolveEmoji', wxid, input),
      voiceWav: (
        wxid: string,
        opts?: { serverId?: string; localId?: number; createTime?: number }
      ): Promise<{ ok: boolean; url?: string; durationMs?: number; error?: string }> =>
        ipcRenderer.invoke('cs:media:voiceWav', wxid, opts),
      voiceTranscript: (
        wxid: string,
        opts?: { serverId?: string; localId?: number; createTime?: number; force?: boolean }
      ): Promise<{
        ok: boolean
        text?: string
        cached?: boolean
        audioDurationMs?: number
        requestId?: string
        error?: string
      }> => ipcRenderer.invoke('cs:media:voiceTranscript', wxid, opts),
      asrStatus: (): Promise<{
        ok: boolean
        available?: boolean
        secretId?: string
        hasSecretKey?: boolean
        region?: string
        engine?: string
        voiceFormat?: string
        reason?: string
        error?: string
      }> => ipcRenderer.invoke('cs:media:asrStatus'),
      asrSaveSecret: (secretKey: string): Promise<{ ok: boolean; error?: string }> =>
        ipcRenderer.invoke('cs:media:asrSaveSecret', secretKey)
    },
    issue: {
      list: (wxid: string): Promise<Result<{ issues?: FeedbackIssue[] }>> =>
        ipcRenderer.invoke('cs:issue:list', wxid),
      overview: (wxid, opts) => ipcRenderer.invoke('cs:issue:overview', wxid, opts),
      analyze: (
        wxid: string
      ): Promise<{ ok: boolean; error?: string; state?: FeedbackAnalysisState }> =>
        ipcRenderer.invoke('cs:issue:analyze', wxid),
      cancel: (wxid: string): Promise<{ ok: boolean; error?: string }> =>
        ipcRenderer.invoke('cs:issue:cancel', wxid),
      archiveStale: (
        wxid: string,
        days: number
      ): Promise<{ ok: boolean; archived?: number; error?: string }> =>
        ipcRenderer.invoke('cs:issue:archiveStale', wxid, days),
      /** 存量去重：dryRun=true 只返回方案（预览），false 才真正合并 */
      mergeDuplicates: (
        wxid: string,
        dryRun?: boolean
      ): Promise<{
        ok: boolean
        clusters?: number
        merged?: number
        plan?: Array<{
          keepId: number
          keepTitle: string
          dropIds: number[]
          dropTitles: string[]
          groupName: string
          reasons: string[]
        }>
        error?: string
      }> => ipcRenderer.invoke('cs:issue:mergeDuplicates', wxid, dryRun),
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
      ): Promise<Result<{ issues?: FeedbackIssue[]; excluded?: boolean }>> =>
        ipcRenderer.invoke('cs:issue:listGroup', wxid, groupUsername),
      setGroupScope: (wxid, groupUsername, excluded, opts) =>
        ipcRenderer.invoke('cs:issue:setGroupScope', wxid, groupUsername, excluded, opts),
      groupSenders: (wxid, groupUsername) =>
        ipcRenderer.invoke('cs:issue:groupSenders', wxid, groupUsername),
      state: (wxid: string): Promise<{ ok: boolean; state?: FeedbackAnalysisState }> =>
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
      detail: (id: number): Promise<Result<{ issue?: FeedbackIssueDetail }>> =>
        ipcRenderer.invoke('cs:issue:detail', id),
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
          settled?: number
        }) => void
      ): (() => void) => {
        const listener = (
          _e: Electron.IpcRendererEvent,
          payload: {
            at?: number
            wxid?: string
            added?: number
            escalate?: number
            settled?: number
          }
        ): void => callback(payload)
        ipcRenderer.on('cs:issue:changed', listener)
        return () => ipcRenderer.removeListener('cs:issue:changed', listener)
      },
      /** 全量重析进度（phase=group 逐群推进；done/cancelled 收尾） */
      onProgress: (
        callback: (payload: {
          wxid?: string
          phase?: 'group' | 'done' | 'cancelled'
          done?: number
          total?: number
          current?: string
        }) => void
      ): (() => void) => {
        const listener = (
          _e: Electron.IpcRendererEvent,
          payload: {
            wxid?: string
            phase?: 'group' | 'done' | 'cancelled'
            done?: number
            total?: number
            current?: string
          }
        ): void => callback(payload)
        ipcRenderer.on('cs:issue:progress', listener)
        return () => ipcRenderer.removeListener('cs:issue:progress', listener)
      }
    },
    team: {
      list: (accountWxid: string): Promise<Result<{ members?: TeamMemberInfo[] }>> =>
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
    customers: {
      sync: (
        accountWxid: string
      ): Promise<{
        ok: boolean
        inserted?: number
        updated?: number
        total?: number
        error?: string
      }> => ipcRenderer.invoke('cs:customers:sync', accountWxid),
      list: (
        accountWxid: string
      ): Promise<{ ok: boolean; items?: CustomerStored[]; error?: string }> =>
        ipcRenderer.invoke('cs:customers:list', accountWxid),
      setTag: (
        accountWxid: string,
        username: string,
        tag: string,
        kind?: 'manual' | 'derived'
      ): Promise<{ ok: boolean; error?: string }> =>
        ipcRenderer.invoke('cs:customers:setTag', accountWxid, username, tag, kind),
      removeTag: (
        accountWxid: string,
        username: string,
        tag: string
      ): Promise<{ ok: boolean; removed?: number; error?: string }> =>
        ipcRenderer.invoke('cs:customers:removeTag', accountWxid, username, tag),
      setFields: (
        accountWxid: string,
        username: string,
        patch: { source?: string; note?: string }
      ): Promise<{ ok: boolean; changed?: boolean; error?: string }> =>
        ipcRenderer.invoke('cs:customers:setFields', accountWxid, username, patch)
    },

    im: {
      list: (): Promise<Result<{ accounts?: ImChannelAccount[] }>> =>
        ipcRenderer.invoke('cs:im:list'),
      save: (input: unknown): Promise<{ ok: boolean; id?: number; error?: string }> =>
        ipcRenderer.invoke('cs:im:save', input),
      remove: (id: number): Promise<{ ok: boolean; error?: string }> =>
        ipcRenderer.invoke('cs:im:remove', id),
      toggle: (id: number, enabled: boolean): Promise<{ ok: boolean; error?: string }> =>
        ipcRenderer.invoke('cs:im:toggle', id, enabled),
      clawQrStart: (
        opts: unknown
      ): Promise<{ ok: boolean; key?: string; qrImg?: string; qrUrl?: string; error?: string }> =>
        ipcRenderer.invoke('cs:im:clawQrStart', opts),
      clawQrPoll: (
        key: string
      ): Promise<{
        ok: boolean
        status: 'waiting' | 'confirmed' | 'expired' | 'error'
        accountId?: number
        error?: string
      }> => ipcRenderer.invoke('cs:im:clawQrPoll', key),
      onStatus: (
        callback: (payload: {
          accountId: number
          status?: string
          statusText?: string
          at?: number
        }) => void
      ): (() => void) => {
        const listener = (
          _e: Electron.IpcRendererEvent,
          payload: { accountId: number; status?: string; statusText?: string; at?: number }
        ): void => callback(payload)
        ipcRenderer.on('cs:im:status', listener)
        return () => ipcRenderer.removeListener('cs:im:status', listener)
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
        skipped?: Array<{ name: string; reason: string }>
        cancelled?: boolean
        error?: string
      }> => ipcRenderer.invoke('cs:export:chat', wxid, opts),
      business: (
        wxid: string,
        folder: string
      ): Promise<{
        ok: boolean
        folder?: string
        name?: string
        cancelled?: boolean
        error?: string
      }> => ipcRenderer.invoke('cs:export:business', wxid, folder),
      cancel: (): Promise<{ ok: boolean; error?: string }> =>
        ipcRenderer.invoke('cs:export:cancel'),
      openFolder: (folder: string): Promise<{ ok: boolean; error?: string }> =>
        ipcRenderer.invoke('cs:export:openFolder', folder),
      writeFile: (
        folder: string,
        name: string,
        content: string
      ): Promise<{ ok: boolean; path?: string; error?: string }> =>
        ipcRenderer.invoke('cs:export:writeFile', folder, name, content),
      onProgress: (callback) => {
        const listener = (
          _e: Electron.IpcRendererEvent,
          evt: Parameters<typeof callback>[0]
        ): void => callback(evt)
        ipcRenderer.on('cs:export:progress', listener)
        return () => ipcRenderer.removeListener('cs:export:progress', listener)
      }
    },
    wb: {
      listChats: (wxid: string): Promise<Result<{ chats?: ChatSessionItem[] }>> =>
        ipcRenderer.invoke('cs:wb:listChats', wxid),
      searchChats: (
        wxid: string,
        query: string
      ): Promise<{
        ok: boolean
        hits?: Array<{
          sessionId: number
          sessionTitle: string
          msgId: number
          role: string
          kind: string
          content: string
          createdAt: number
        }>
        error?: string
      }> => ipcRenderer.invoke('cs:wb:searchChats', wxid, query),
      messages: (id: number): Promise<Result<{ messages?: ChatMsgItem[] }>> =>
        ipcRenderer.invoke('cs:wb:messages', id),
      getWorkspace: (id: number): Promise<{ ok: boolean; path?: string | null; error?: string }> =>
        ipcRenderer.invoke('cs:wb:getWorkspace', id),
      setWorkspace: (id: number, dir: string | null): Promise<{ ok: boolean; error?: string }> =>
        ipcRenderer.invoke('cs:wb:setWorkspace', id, dir),
      openWorkspace: (id: number): Promise<{ ok: boolean; error?: string }> =>
        ipcRenderer.invoke('cs:wb:openWorkspace', id),
      feedback: (input: {
        sessionId: number
        messageId: number
        value: number
        reason?: string
      }): Promise<{ ok: boolean; error?: string }> => ipcRenderer.invoke('cs:wb:feedback', input),
      create: (
        wxid: string,
        title: string
      ): Promise<{ ok: boolean; id?: number; error?: string }> =>
        ipcRenderer.invoke('cs:wb:create', wxid, title),
      send: (
        id: number,
        wxid: string,
        text: string,
        images?: string[]
      ): Promise<{ ok: boolean; error?: string }> =>
        ipcRenderer.invoke('cs:wb:send', id, wxid, text, images),
      retry: (id: number, wxid: string): Promise<{ ok: boolean; error?: string }> =>
        ipcRenderer.invoke('cs:wb:retry', id, wxid),
      resend: (id: number, wxid: string, text: string): Promise<{ ok: boolean; error?: string }> =>
        ipcRenderer.invoke('cs:wb:resend', id, wxid, text),
      stop: (id: number): Promise<{ ok: boolean }> => ipcRenderer.invoke('cs:wb:stop', id),
      approve: (runId: string, ok: boolean): Promise<{ ok: boolean }> =>
        ipcRenderer.invoke('cs:wb:approve', runId, ok),
      trustTool: (
        sid: number,
        tool: string,
        scope: 'session' | 'global'
      ): Promise<{ ok: boolean; error?: string }> =>
        ipcRenderer.invoke('cs:wb:trustTool', sid, tool, scope),
      // 出入参交给共享接口做上下文推断（mode 是字面量联合，别再手抄一份）
      getApprovalPrefs: () => ipcRenderer.invoke('cs:wb:getApprovalPrefs'),
      setApprovalPrefs: (input) => ipcRenderer.invoke('cs:wb:setApprovalPrefs', input),
      rename: (id: number, title: string): Promise<{ ok: boolean; error?: string }> =>
        ipcRenderer.invoke('cs:wb:rename', id, title),
      remove: (id: number): Promise<{ ok: boolean; error?: string }> =>
        ipcRenderer.invoke('cs:wb:remove', id),
      clear: (id: number): Promise<{ ok: boolean; error?: string }> =>
        ipcRenderer.invoke('cs:wb:clear', id),
      getMemoNotes: (): Promise<{ ok: boolean; notes?: string; error?: string }> =>
        ipcRenderer.invoke('cs:wb:getMemoNotes'),
      setMemoNotes: (notes: string): Promise<{ ok: boolean; error?: string }> =>
        ipcRenderer.invoke('cs:wb:setMemoNotes', notes),
      reliability: (): Promise<{
        ok: boolean
        stats?: {
          total: number
          ok: number
          fail: number
          rate: number | null
          lastFailures: Array<{ at: number; err: string }>
        }
        error?: string
      }> => ipcRenderer.invoke('cs:wb:reliability'),
      exportSession: (id: number): Promise<{ ok: boolean; file?: string; error?: string }> =>
        ipcRenderer.invoke('cs:wb:exportSession', id),
      removeAll: (wxid: string): Promise<{ ok: boolean; removed?: number; error?: string }> =>
        ipcRenderer.invoke('cs:wb:removeAll', wxid),
      skills: (): Promise<
        Result<{
          skills?: {
            name: string
            description: string
            enabled: boolean
            sizeBytes: number
            dirName: string
          }[]
          maxOn?: number
        }>
      > => ipcRenderer.invoke('cs:wb:skills'),
      setSkillLimit: (n: number): Promise<{ ok: boolean; maxOn?: number; error?: string }> =>
        ipcRenderer.invoke('cs:wb:setSkillLimit', n),
      toggleSkill: (name: string, enabled: boolean): Promise<{ ok: boolean; error?: string }> =>
        ipcRenderer.invoke('cs:wb:toggleSkill', name, enabled),
      openSkillsDir: (): Promise<{ ok: boolean; path?: string; error?: string }> =>
        ipcRenderer.invoke('cs:wb:openSkillsDir'),
      onEvent: (callback) => {
        const listener = (
          _e: Electron.IpcRendererEvent,
          payload: Parameters<typeof callback>[0]
        ): void => callback(payload)
        ipcRenderer.on('ai:wb', listener)
        return () => ipcRenderer.removeListener('ai:wb', listener)
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
        ipcRenderer.invoke('cs:agent:save', input)
    },
    duty: {
      backfillIntent: (limit?: number) => ipcRenderer.invoke('cs:duty:backfillIntent', limit),
      status: (wxid: string) => ipcRenderer.invoke('cs:duty:status', wxid),
      scripts: (wxid: string) => ipcRenderer.invoke('cs:duty:scripts', wxid),
      scriptSave: (wxid, input) => ipcRenderer.invoke('cs:duty:scriptSave', wxid, input),
      scriptRemove: (wxid, id) => ipcRenderer.invoke('cs:duty:scriptRemove', wxid, id),
      scriptToggle: (wxid, id, enabled) =>
        ipcRenderer.invoke('cs:duty:scriptToggle', wxid, id, enabled),
      scriptImport: (wxid, rows) => ipcRenderer.invoke('cs:duty:scriptImport', wxid, rows),
      seedStarters: (wxid: string) => ipcRenderer.invoke('cs:duty:seedStarters', wxid),
      groups: (wxid: string) => ipcRenderer.invoke('cs:duty:groups', wxid),
      groupsSet: (wxid, groups, patch) =>
        ipcRenderer.invoke('cs:duty:groupsSet', wxid, groups, patch),
      groupOne: (wxid: string, group: string) =>
        ipcRenderer.invoke('cs:duty:groupOne', wxid, group),
      groupSet: (wxid, group, patch) => ipcRenderer.invoke('cs:duty:groupSet', wxid, group, patch),
      replies: (wxid, opts) => ipcRenderer.invoke('cs:duty:replies', wxid, opts),
      feedback: (id, feedback) => ipcRenderer.invoke('cs:duty:feedback', id, feedback),
      run: (wxid: string) => ipcRenderer.invoke('cs:duty:run', wxid),
      preview: (wxid, opts) => ipcRenderer.invoke('cs:duty:preview', wxid, opts)
    },
    feishuNotify: {
      get: (): Promise<{
        ok: boolean
        config?: {
          enabled: boolean
          targets: Array<{ kind: 'chat' | 'user'; id: string; name: string }>
          events: string[]
          dailyLimit: number
        }
        credential?: {
          configured: boolean
          source: string
          appIdMasked: string
          accountName?: string
        }
        recent?: Array<{
          id: number
          targetKind: string
          targetId: string
          targetName: string
          content: string
          source: string
          result: string
          error?: string
          createdAt: number
        }>
        error?: string
      }> => ipcRenderer.invoke('cs:feishu:notify:get'),
      setEnabled: (on: boolean): Promise<{ ok: boolean; error?: string }> =>
        ipcRenderer.invoke('cs:feishu:notify:setEnabled', on),
      setEvent: (evt: string, on: boolean): Promise<{ ok: boolean; error?: string }> =>
        ipcRenderer.invoke('cs:feishu:notify:setEvent', evt, on),
      // ── 每日日报（与实时告警分开开关，共用接收目标）──
      digestGet: (): Promise<{ ok: boolean; config?: LarkDigestConfig; error?: string }> =>
        ipcRenderer.invoke('cs:feishu:digest:get'),
      digestSet: (patch: {
        enabled?: boolean
        time?: string
        includeAgent?: boolean
      }): Promise<{ ok: boolean; config?: LarkDigestConfig; error?: string }> =>
        ipcRenderer.invoke('cs:feishu:digest:set', patch),
      digestSend: (
        wxid: string,
        markSent?: boolean
      ): Promise<{
        ok: boolean
        sent: number
        text: string
        error?: string
        config?: LarkDigestConfig
      }> => ipcRenderer.invoke('cs:feishu:digest:send', wxid, markSent),
      addTarget: (input: {
        kind: 'chat' | 'user'
        id: string
        name?: string
      }): Promise<{ ok: boolean; error?: string }> =>
        ipcRenderer.invoke('cs:feishu:notify:addTarget', input),
      removeTarget: (kind: 'chat' | 'user', id: string): Promise<{ ok: boolean; error?: string }> =>
        ipcRenderer.invoke('cs:feishu:notify:removeTarget', kind, id),
      test: (): Promise<{ ok: boolean; sent?: number; error?: string }> =>
        ipcRenderer.invoke('cs:feishu:notify:test'),
      sendGroupIssues: (
        wxid: string,
        chatroom: string,
        targetName?: string
      ): Promise<{
        ok: boolean
        sent?: number
        count?: number
        targets?: string[]
        error?: string
      }> => ipcRenderer.invoke('cs:feishu:notify:sendGroupIssues', wxid, chatroom, targetName),
      listChats: (): Promise<{
        ok: boolean
        chats?: Array<{ chatId: string; name: string; chatMode: string }>
        error?: string
      }> => ipcRenderer.invoke('cs:feishu:notify:listChats'),
      resolveUser: (email: string): Promise<{ ok: boolean; openId?: string; error?: string }> =>
        ipcRenderer.invoke('cs:feishu:notify:resolveUser', email),
      contactScope: (): Promise<{
        ok: boolean
        departments?: Array<{ id: string; name: string }>
        users?: Array<{ openId: string; name: string; email?: string }>
        empty?: boolean
        authUrl?: string
        appIdMasked?: string
        error?: string
      }> => ipcRenderer.invoke('cs:feishu:contact:scope'),
      contactDepartments: (
        parentId: string
      ): Promise<{
        ok: boolean
        departments?: Array<{ id: string; name: string }>
        hasMore?: boolean
        error?: string
      }> => ipcRenderer.invoke('cs:feishu:contact:departments', parentId),
      contactUsers: (
        deptId: string,
        pageToken?: string
      ): Promise<{
        ok: boolean
        users?: Array<{ openId: string; name: string; email?: string }>
        hasMore?: boolean
        pageToken?: string
        error?: string
      }> => ipcRenderer.invoke('cs:feishu:contact:users', deptId, pageToken),
      openAuthUrl: (url: string): Promise<{ ok: boolean; error?: string }> =>
        ipcRenderer.invoke('cs:feishu:contact:openAuth', url),
      listAudit: (
        limit?: number,
        onlyTasks?: boolean
      ): Promise<{ ok: boolean; logs?: ImAuditEntry[]; error?: string }> =>
        ipcRenderer.invoke('cs:feishu:audit:list', limit, onlyTasks)
    },
    lark: {
      status: (): Promise<{
        ok: boolean
        configured?: boolean
        source?: 'config' | 'im' | 'none'
        appIdMasked?: string
        accountName?: string
        defaultUrl?: string
        error?: string
      }> => ipcRenderer.invoke('cs:lark:status'),
      test: (url: string): Promise<{ ok: boolean; text?: string; error?: string }> =>
        ipcRenderer.invoke('cs:lark:test', url),
      // ── 议题 → 多维表格（Base）同步 ──
      baseStatus: (): Promise<{ ok: boolean; status?: LarkBaseStatus; error?: string }> =>
        ipcRenderer.invoke('cs:lark:baseStatus'),
      basePreview: (link: string): Promise<LarkBaseVerify> =>
        ipcRenderer.invoke('cs:lark:basePreview', link),
      baseVerify: (link: string): Promise<LarkBaseVerify> =>
        ipcRenderer.invoke('cs:lark:baseVerify', link),
      baseClaim: (
        wxid: string
      ): Promise<{
        ok: boolean
        claimed?: { scanned: number; claimed: number; already: number; unmatched: number }
        status?: LarkBaseStatus
        error?: string
      }> => ipcRenderer.invoke('cs:lark:baseClaim', wxid),
      baseFieldMap: (
        map?: Record<string, string> | null
      ): Promise<{
        ok: boolean
        fieldMap?: Record<string, string>
        status?: LarkBaseStatus
        error?: string
      }> => ipcRenderer.invoke('cs:lark:baseFieldMap', map ?? null),
      baseSync: (
        wxid: string,
        force?: boolean,
        pull?: boolean
      ): Promise<{
        ok: boolean
        result?: LarkSyncOut
        pulled?: LarkPullResult | null
        replies?: LarkSyncOut
        status?: LarkBaseStatus
        error?: string
      }> => ipcRenderer.invoke('cs:lark:baseSync', wxid, force, pull),
      basePull: (
        wxid: string
      ): Promise<{
        ok: boolean
        pulled?: LarkPullResult
        status?: LarkBaseStatus
        error?: string
      }> => ipcRenderer.invoke('cs:lark:basePull', wxid),
      baseConfig: (patch: {
        enabled?: boolean
        rawEvidence?: boolean
      }): Promise<{ ok: boolean; status?: LarkBaseStatus; error?: string }> =>
        ipcRenderer.invoke('cs:lark:baseConfig', patch),
      baseClear: (): Promise<{ ok: boolean; status?: LarkBaseStatus; error?: string }> =>
        ipcRenderer.invoke('cs:lark:baseClear'),
      // ── 把表格升级成「工单台」 ──
      baseSystemUpgrade: (): Promise<LarkSystemUpgrade> =>
        ipcRenderer.invoke('cs:lark:baseSystemUpgrade'),
      basePerson: (patch?: {
        enabled?: boolean
        field?: string
        manual?: string
      }): Promise<{
        ok: boolean
        person?: LarkPersonConfig
        status?: LarkBaseStatus
        error?: string
      }> => ipcRenderer.invoke('cs:lark:basePerson', patch ?? {}),
      basePersonRefresh: (): Promise<{
        ok: boolean
        mapped: number
        names: string[]
        hint?: string
        error?: string
        status?: LarkBaseStatus
      }> => ipcRenderer.invoke('cs:lark:basePersonRefresh'),
      // ── 证据明细 → 「议题证据」子表 ──
      baseEvidence: (patch?: {
        enabled?: boolean
        days?: number
        maxPerIssue?: number
        maxChars?: number
        media?: boolean
        maxMediaMB?: number
        maxUploadsPerRound?: number
      }): Promise<{
        ok: boolean
        evidence?: LarkEvidenceConfig
        status?: LarkBaseStatus
        error?: string
      }> => ipcRenderer.invoke('cs:lark:baseEvidence', patch ?? {}),
      baseEvidenceSetup: (): Promise<LarkEvidenceSetup> =>
        ipcRenderer.invoke('cs:lark:baseEvidenceSetup'),
      baseEvidenceClean: (): Promise<{
        ok: boolean
        removed: number
        status?: LarkBaseStatus
        error?: string
      }> => ipcRenderer.invoke('cs:lark:baseEvidenceClean')
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
        ipcRenderer.invoke('cs:app:clearCache'),
      setTheme: (mode: 'light' | 'dark' | 'system'): Promise<{ ok: boolean; dark?: boolean }> =>
        ipcRenderer.invoke('cs:app:setTheme', mode)
    },
    report: {
      list: (): Promise<Result<{ jobs?: ReportJobInfo[] }>> => ipcRenderer.invoke('cs:report:list'),
      save: (input): Promise<{ ok: boolean; id?: number; error?: string }> =>
        ipcRenderer.invoke('cs:report:save', input),
      remove: (id: number): Promise<{ ok: boolean; error?: string }> =>
        ipcRenderer.invoke('cs:report:remove', id),
      setEnabled: (id: number, enabled: boolean): Promise<{ ok: boolean; error?: string }> =>
        ipcRenderer.invoke('cs:report:setEnabled', id, enabled),
      runNow: (id: number): Promise<{ ok: boolean; summary?: string; error?: string }> =>
        ipcRenderer.invoke('cs:report:runNow', id),
      cancel: (id: number): Promise<{ ok: boolean; error?: string }> =>
        ipcRenderer.invoke('cs:report:cancel', id),
      onProgress: (callback) => {
        const listener = (
          _e: Electron.IpcRendererEvent,
          payload: Parameters<typeof callback>[0]
        ): void => callback(payload)
        ipcRenderer.on('cs:report:progress', listener)
        return () => ipcRenderer.removeListener('cs:report:progress', listener)
      },
      testConn: (opts) => ipcRenderer.invoke('cs:report:testConn', opts),
      history: (id: number): Promise<Result<{ runs?: ReportRunInfo[] }>> =>
        ipcRenderer.invoke('cs:report:history', id)
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
