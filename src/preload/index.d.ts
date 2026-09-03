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
  RedEnvelopeStatus
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
          startWatch: (wxid: string) => Promise<Result<{}>>
          stopWatch: (wxid: string) => Promise<Result<{}>>
          opsStats: (
            wxid: string,
            rangeDays?: number
          ) => Promise<{ ok: boolean; stats?: OpsStats; error?: string }>
          onDbChanged: (callback: (payload: DbChangedPayload) => void) => () => void
        }
        ai: {
          generateReply: (
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
          pickDirectory: (title?: string, defaultPath?: string) => Promise<{ ok: boolean; path?: string }>
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
        }
        issue: {
          list: (wxid: string) => Promise<Result<{ issues?: FeedbackIssue[] }>>
          analyze: (wxid: string) => Promise<{ ok: boolean; state?: FeedbackAnalysisState; error?: string }>
          state: (wxid: string) => Promise<{ ok: boolean; state?: FeedbackAnalysisState }>
          clear: (wxid: string) => Promise<{ ok: boolean; error?: string }>
          setStatus: (
            id: number,
            status: FeedbackIssueStatus
          ) => Promise<{ ok: boolean; error?: string }>
          detail: (id: number) => Promise<Result<{ issue?: FeedbackIssueDetail }>>
          typeCounts: (wxid: string) => Promise<Result<{ counts?: FeedbackTypeCount[] }>>
        }
        agent: {
          list: () => Promise<Result<{ agents?: AiAgent[]; defaultId?: string | null }>>
          save: (input: AiAgentInput) => Promise<Result<{ agent?: AiAgent }>>
          remove: (id: string) => Promise<{ ok: boolean; error?: string }>
          setDefault: (id: string) => Promise<{ ok: boolean; error?: string }>
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
      }
    }
  }
}
