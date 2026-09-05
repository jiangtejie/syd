import { ElectronAPI } from '@electron-toolkit/preload'
import type {
  KeySource,
  KeyAccountInfo,
  KeyStatusInfo,
  SessionSummary,
  ChatMessage,
  WxConnectInfo,
  DbChangedPayload,
  AiGenOptions,
  ReplyCandidate,
  AiAgent,
  AiAgentInput,
  SendResult,
  SendStatusInfo,
  SendOverview,
  OpsStats,
  MessageCursor,
  RedEnvelopeStatus,
  FeedbackTypeCount,
  TeamMemberInfo,
  ChatSessionItem,
  ChatMsgItem,
  AiChatEvent,
  ImChannelAccount,
  ImChannelAccountInput
} from '../shared/types'

interface KeyActionResult {
  success: boolean
  error?: string
}

type Result<T> = ({ ok: true } & T) | { ok: false; error?: string }

type AiReplyResult = {
  ok: boolean
  candidates?: ReplyCandidate[]
  llm?: boolean
  error?: string
  toolsUsed?: string[]
}

declare global {
  interface Window {
    electron: ElectronAPI
    api: {
      cs: {
        keyStore: {
          getStatus: (wxid: string) => Promise<KeyStatusInfo>
          list: () => Promise<KeyAccountInfo[]>
          importKey: (
            wxid: string,
            keyHex: string,
            source: KeySource,
            dbPath?: string
          ) => Promise<KeyActionResult>
          test: (wxid: string) => Promise<KeyActionResult>
          refresh: (wxid: string) => Promise<KeyStatusInfo>
        }
        wx: {
          connect: (wxid: string) => Promise<Result<{ info?: WxConnectInfo }>>
          getSessions: (wxid: string) => Promise<Result<{ sessions?: SessionSummary[] }>>
          getMessages: (
            wxid: string,
            sessionId: string,
            limit?: number,
            before?: MessageCursor
          ) => Promise<
            Result<{ messages?: ChatMessage[]; hasMore?: boolean; nextCursor?: MessageCursor }>
          >
          getMessagesSince: (
            wxid: string,
            sessionId: string,
            sinceSortSeq: number
          ) => Promise<Result<{ messages?: ChatMessage[] }>>
          getRedEnvelopeStatuses: (
            wxid: string,
            sessionId: string
          ) => Promise<Result<{ statuses?: RedEnvelopeStatus[] }>>
          getAvatar: (
            wxid: string,
            username: string,
            localOnly?: boolean
          ) => Promise<Result<{ url?: string }>>
          contactNames: (
            wxid: string,
            usernames: string[]
          ) => Promise<{ ok: boolean; names?: Record<string, string>; error?: string }>
          startWatch: (wxid: string) => Promise<{ ok: boolean; error?: string }>
          stopWatch: (wxid: string) => Promise<{ ok: boolean; error?: string }>
          opsStats: (
            wxid: string,
            rangeDays?: number
          ) => Promise<{ ok: boolean; stats?: OpsStats; error?: string }>
          onDbChanged: (callback: (payload: DbChangedPayload) => void) => () => void
        }
        ai: {
          generateReply: (
            wxid: string,
            sessionId: string,
            sessionName: string,
            messages: ChatMessage[],
            opts?: AiGenOptions
          ) => Promise<AiReplyResult>
          test: (input?: {
            baseUrl?: string
            apiKey?: string
            model?: string
            timeoutMs?: number
          }) => Promise<{ ok: boolean; latencyMs?: number; error?: string }>
          models: (input?: {
            baseUrl?: string
            apiKey?: string
            timeoutMs?: number
          }) => Promise<{ ok: boolean; models?: string[]; error?: string }>
        }
        reply: {
          sendText: (args: {
            wxid: string
            sessionId: string
            targetName: string
            text: string
            source?: string
          }) => Promise<{ ok: boolean; result?: SendResult; error?: string }>
          sendFile: (args: {
            wxid: string
            sessionId: string
            targetName: string
            path: string
            kind: 'image' | 'file'
            source?: string
          }) => Promise<{ ok: boolean; result?: SendResult; error?: string }>
          getSendStatus: () => Promise<SendStatusInfo>
          stats7d: () => Promise<Array<{ day: string; sent: number; failed: number }>>
          overview: () => Promise<{ ok: boolean; data?: SendOverview; error?: string }>
          resetCircuit: () => Promise<{ ok: boolean }>
        }
        config: {
          getAll: () => Promise<Record<string, string>>
          set: (key: string, value: string) => Promise<{ ok: boolean; error?: string }>
          cachePath: () => Promise<{
            ok: boolean
            path?: string
            defaultPath?: string
            isDefault?: boolean
          }>
        }
        dialog: {
          pickDirectory: (
            title?: string,
            defaultPath?: string
          ) => Promise<{ ok: boolean; path?: string }>
          pickFiles: (opts?: {
            title?: string
            multi?: boolean
            filters?: Array<{ name: string; extensions: string[] }>
          }) => Promise<{ ok: boolean; paths?: string[] }>
        }
        logs: {
          recent: (opts?: {
            minLevel?: 'debug' | 'info' | 'warn' | 'error'
            scope?: string
            query?: string
            max?: number
          }) => Promise<{
            ok: boolean
            entries?: Array<{ ts: number; level: string; scope: string; msg: string }>
            error?: string
          }>
          openFolder: () => Promise<{ ok: boolean; error?: string }>
          clear: () => Promise<{ ok: boolean; removed?: number; error?: string }>
        }
        media: {
          decryptImage: (opts: {
            wxid: string
            imageMd5: string
            kind?: 'orig' | 'thumb' | 'hd'
            dbPath?: string
          }) => Promise<{ ok: boolean; url?: string; ext?: string; error?: string }>
          decryptVideo: (opts: {
            wxid: string
            videoMd5: string
            dbPath?: string
          }) => Promise<{ ok: boolean; url?: string; error?: string }>
          testImageDecrypt: (
            wxid: string,
            dbPath?: string
          ) => Promise<{ ok: boolean; url?: string; ext?: string; error?: string }>
          resolveEmoji: (
            wxid: string,
            input: { md5?: string; productId?: string; cdnUrl?: string }
          ) => Promise<{ ok: boolean; url?: string; error?: string }>
        }
        issue: {
          list: (wxid: string) => Promise<Result<{ issues?: FeedbackIssue[] }>>
          analyze: (
            wxid: string
          ) => Promise<{ ok: boolean; state?: FeedbackAnalysisState; error?: string }>
          analyzeGroup: (
            wxid: string,
            groupUsername: string,
            groupName?: string,
            opts?: { days?: number; force?: boolean; reset?: boolean }
          ) => Promise<{
            ok: boolean
            error?: string
            skipped?: boolean
            method?: 'llm' | 'rule'
            count?: number
            lastAt?: number
          }>
          listGroup: (
            wxid: string,
            groupUsername: string
          ) => Promise<Result<{ issues?: FeedbackIssue[] }>>
          state: (wxid: string) => Promise<{ ok: boolean; state?: FeedbackAnalysisState }>
          clear: (wxid: string) => Promise<{ ok: boolean; error?: string }>
          clearGroup: (
            wxid: string,
            groupUsername: string
          ) => Promise<{ ok: boolean; error?: string }>
          setStatus: (
            id: number,
            status: FeedbackIssueStatus
          ) => Promise<{ ok: boolean; error?: string }>
          assign: (id: number, username: string | null) => Promise<{ ok: boolean; error?: string }>
          confirmDoubt: (id: number) => Promise<{ ok: boolean; error?: string }>
          detail: (id: number) => Promise<Result<{ issue?: FeedbackIssueDetail }>>
          typeCounts: (wxid: string) => Promise<Result<{ counts?: FeedbackTypeCount[] }>>
          groupBadges: (
            wxid: string
          ) => Promise<{ ok: boolean; badges?: Record<string, number>; error?: string }>
          onChanged: (
            callback: (payload: {
              at?: number
              wxid?: string
              added?: number
              escalate?: number
            }) => void
          ) => () => void
        }
        team: {
          list: (accountWxid: string) => Promise<Result<{ members?: TeamMemberInfo[] }>>
          save: (
            accountWxid: string,
            username: string,
            label?: string
          ) => Promise<{ ok: boolean; error?: string }>
          remove: (
            accountWxid: string,
            username: string
          ) => Promise<{ ok: boolean; error?: string }>
        }

        im: {
          list: () => Promise<Result<{ accounts?: ImChannelAccount[] }>>
          save: (
            input: ImChannelAccountInput
          ) => Promise<{ ok: boolean; id?: number; error?: string }>
          remove: (id: number) => Promise<{ ok: boolean; error?: string }>
          toggle: (id: number, enabled: boolean) => Promise<{ ok: boolean; error?: string }>
          onStatus: (
            callback: (payload: {
              accountId: number
              status?: string
              statusText?: string
              at?: number
            }) => void
          ) => () => void
        }
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
          ) => Promise<{
            ok: boolean
            folder?: string
            files?: Array<{ name: string; msgCount: number }>
            error?: string
          }>
          business: (
            wxid: string,
            folder: string
          ) => Promise<{ ok: boolean; folder?: string; name?: string; error?: string }>
          openFolder: (folder: string) => Promise<{ ok: boolean; error?: string }>
          writeFile: (
            folder: string,
            name: string,
            content: string
          ) => Promise<{ ok: boolean; path?: string; error?: string }>
          onProgress: (
            callback: (evt: {
              phase: string
              current: number
              total: number
              name: string
              detail: string
            }) => void
          ) => () => void
        }
        agent: {
          list: () => Promise<Result<{ agents?: AiAgent[]; defaultId?: string | null }>>
          save: (input: AiAgentInput) => Promise<Result<{ agent?: AiAgent }>>
        }
        app: {
          onNavigate: (callback: (page: string) => void) => () => void
          info: () => Promise<{
            version: string
            electron: string
            chrome: string
            node: string
            platform: string
          }>
          getAutoLaunch: () => Promise<{ ok: boolean; enabled?: boolean }>
          setAutoLaunch: (enabled: boolean) => Promise<{ ok: boolean; enabled?: boolean }>
          dataStats: () => Promise<{
            ok: boolean
            dbBytes?: number
            cacheBytes?: number
            cachePath?: string
          }>
          clearCache: () => Promise<{ ok: boolean; error?: string }>
        }
        wb: {
          listChats: (wxid: string) => Promise<Result<{ chats?: ChatSessionItem[] }>>
          searchChats: (
            wxid: string,
            query: string
          ) => Promise<
            Result<{
              hits?: Array<{
                sessionId: number
                sessionTitle: string
                msgId: number
                role: string
                kind: string
                content: string
                createdAt: number
              }>
            }>
          >
          messages: (id: number) => Promise<Result<{ messages?: ChatMsgItem[] }>>
          feedback: (input: {
            sessionId: number
            messageId: number
            value: number
            reason?: string
          }) => Promise<{ ok: boolean; error?: string }>
          create: (
            wxid: string,
            title: string
          ) => Promise<{ ok: boolean; id?: number; error?: string }>
          send: (
            id: number,
            wxid: string,
            text: string,
            images?: string[]
          ) => Promise<{ ok: boolean; error?: string }>
          retry: (id: number, wxid: string) => Promise<{ ok: boolean; error?: string }>
          resend: (
            id: number,
            wxid: string,
            text: string
          ) => Promise<{ ok: boolean; error?: string }>
          stop: (id: number) => Promise<{ ok: boolean }>
          approve: (runId: string, ok: boolean) => Promise<{ ok: boolean }>
          trustTool: (
            sid: number,
            tool: string,
            scope: 'session' | 'global'
          ) => Promise<{ ok: boolean; error?: string }>
          getApprovalPrefs: () => Promise<{
            ok: boolean
            prefs?: { mode: 'ask' | 'allow' | 'deny'; allow: string[]; deny: string[] }
            error?: string
          }>
          setApprovalPrefs: (input: {
            mode?: 'ask' | 'allow' | 'deny'
            allow?: string[]
            deny?: string[]
          }) => Promise<{
            ok: boolean
            prefs?: { mode: 'ask' | 'allow' | 'deny'; allow: string[]; deny: string[] }
            error?: string
          }>
          rename: (id: number, title: string) => Promise<{ ok: boolean; error?: string }>
          remove: (id: number) => Promise<{ ok: boolean; error?: string }>
          clear: (id: number) => Promise<{ ok: boolean; error?: string }>
          exportSession: (id: number) => Promise<{ ok: boolean; file?: string; error?: string }>
          getMemoNotes: () => Promise<{ ok: boolean; notes?: string; error?: string }>
          setMemoNotes: (notes: string) => Promise<{ ok: boolean; error?: string }>
          reliability: () => Promise<
            Result<{
              stats?: {
                total: number
                ok: number
                fail: number
                rate: number | null
                lastFailures: Array<{ at: number; err: string }>
              }
            }>
          >
          removeAll: (wxid: string) => Promise<{ ok: boolean; removed?: number; error?: string }>
          skills: () => Promise<
            Result<{
              skills?: Array<{
                name: string
                description: string
                enabled: boolean
                sizeBytes: number
                dirName: string
              }>
            }>
          >
          toggleSkill: (name: string, enabled: boolean) => Promise<{ ok: boolean; error?: string }>
          openSkillsDir: () => Promise<{ ok: boolean; path?: string; error?: string }>
          onEvent: (
            callback: (evt: AiChatEvent & { sessionId?: number; runId?: string }) => void
          ) => () => void
        }
      }
    }
  }
}
