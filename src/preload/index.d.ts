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
  McpServerItem,
  McpServerInput,
  CustomToolItem,
  CustomToolInput,
  AgentMemoryItem,
  AgentMemoryInput,
  SkillPackageItem,
  SkillInstallInfo,
  ImChannelAccount,
  ImChannelAccountInput,
  WorkspaceSessionItem
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
        aiChat: {
          listChats: (wxid: string) => Promise<Result<{ chats?: ChatSessionItem[] }>>
          messages: (sessionId: number) => Promise<Result<{ messages?: ChatMsgItem[] }>>
          renameChat: (sessionId: number, title: string) => Promise<{ ok: boolean; error?: string }>
          removeChat: (sessionId: number) => Promise<{ ok: boolean; error?: string }>
          clearChat: (sessionId: number) => Promise<{ ok: boolean; error?: string }>
          send: (input: {
            wxid: string
            chatId?: number
            agentId?: string | null
            text: string
          }) => Promise<{ ok: boolean; chatId?: number; error?: string }>
          stop: (wxid: string, sessionId: number) => Promise<{ ok: boolean }>
          retry: (
            wxid: string,
            sessionId: number,
            agentId?: string | null
          ) => Promise<{ ok: boolean; chatId?: number; error?: string }>
          confirmTool: (runId: string, ok: boolean) => Promise<{ ok: boolean; error?: string }>
          setAgent: (
            sessionId: number,
            agentId: string | null
          ) => Promise<{ ok: boolean; error?: string }>
          onEvent: (callback: (evt: AiChatEvent) => void) => () => void
        }
        mcp: {
          list: () => Promise<Result<{ servers?: McpServerItem[] }>>
          save: (input: McpServerInput) => Promise<Result<{ item?: McpServerItem }>>
          remove: (id: number) => Promise<{ ok: boolean; error?: string }>
        }
        tool: {
          list: () => Promise<Result<{ tools?: CustomToolItem[] }>>
          save: (input: CustomToolInput) => Promise<Result<{ item?: CustomToolItem }>>
          remove: (id: number) => Promise<{ ok: boolean; error?: string }>
        }
        memory: {
          list: () => Promise<Result<{ items?: AgentMemoryItem[] }>>
          save: (input: AgentMemoryInput) => Promise<Result<{ item?: AgentMemoryItem }>>
          remove: (id: number) => Promise<{ ok: boolean; error?: string }>
        }
        skill: {
          list: () => Promise<Result<{ skills?: SkillPackageItem[] }>>
          inspect: (dir: string) => Promise<Result<{ info?: SkillInstallInfo }>>
          install: (dir: string) => Promise<{ ok: boolean; error?: string }>
          remove: (id: number) => Promise<{ ok: boolean; error?: string }>
          toggle: (id: number, enabled: boolean) => Promise<{ ok: boolean; error?: string }>
        }
        cap: {
          software: () => Promise<
            Result<{
              caps?: Array<{
                name: string
                oneLine: string
                when: string
                needsWx: boolean
                disabled: boolean
              }>
            }>
          >
          setSoftware: (name: string, enabled: boolean) => Promise<{ ok: boolean; error?: string }>
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
        ws: {
          list: () => Promise<Result<{ sessions?: WorkspaceSessionItem[] }>>
          create: (
            cwd: string,
            title: string
          ) => Promise<{ ok: boolean; id?: number; error?: string }>
          rename: (id: number, title: string) => Promise<{ ok: boolean; error?: string }>
          remove: (id: number) => Promise<{ ok: boolean; error?: string }>
          messages: (id: number) => Promise<Result<{ messages?: ChatMsgItem[] }>>
          send: (id: number, text: string) => Promise<{ ok: boolean; error?: string }>
          retry: (id: number) => Promise<{ ok: boolean; error?: string }>
          stop: (id: number) => Promise<{ ok: boolean }>
          confirm: (runId: string, ok: boolean) => Promise<{ ok: boolean }>
          preview: (cwd: string) => Promise<{ ok: boolean; tree?: string; error?: string }>
          onEvent: (callback: (evt: AiChatEvent & { sessionId?: number }) => void) => () => void
        }
      }
    }
  }
}
