import type {
  FeedbackAnalysisState,
  FeedbackIssue,
  FeedbackIssueDetail,
  FeedbackIssueStatus,
  ImAuditEntry,
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
  TeamMemberInfo,
  ChatSessionItem,
  ChatMsgItem,
  AiChatEvent,
  ImChannelAccount,
  ImChannelAccountInput,
  ReportJobInfo,
  ReportJobInput,
  ReportPgTarget,
  ReportRunInfo
} from './types'
import type {
  GrowthBuzzAddResult,
  GrowthBuzzCommentsResult,
  GrowthBuzzDetailView,
  GrowthBuzzDiagnosisView,
  GrowthBuzzFilter,
  GrowthBuzzMentionView,
  GrowthBuzzOverview,
  GrowthContentDetailView,
  GrowthContentFilter,
  GrowthContentItem,
  GrowthCrawlTaskView,
  GrowthOverview,
  GrowthProgressPayload,
  GrowthStats,
  GrowthSubscription,
  GrowthSubscriptionInput
} from './growth'

export interface KeyActionResult {
  success: boolean
  error?: string
}

export type Result<T> = ({ ok: true } & T) | { ok: false; error?: string }

export type AiReplyResult = {
  ok: boolean
  candidates?: ReplyCandidate[]
  llm?: boolean
  error?: string
  toolsUsed?: string[]
}


/**
 * 主进程 ↔ 渲染端桥接口(cs 命名空间)的**唯一真源**。
 *
 * 为什么放在 shared:preload 实现以 `const api: CsApi` 对着它编译,渲染端 window.api 也用它,
 * 因此「实现加了方法但声明忘了同步」「声明的参数与实现不一致」都会直接编译失败,
 * 不会再出现类型漂移(历史上就漏同步过 mergeDuplicates/archiveStale)。
 */
/** 桥接口整体(目前只有 cs 一个命名空间；以后新增命名空间在此登记) */
export interface PreloadApi {
  cs: CsApi
}

export interface CsApi {
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
        sinceMs?: number
        max?: number
      }) => Promise<{
        ok: boolean
        entries?: Array<{ ts: number; level: string; scope: string; msg: string }>
        error?: string
      }>
      openFolder: () => Promise<{ ok: boolean; error?: string }>
      clear: () => Promise<{ ok: boolean; removed?: number; error?: string }>
      applyConfig: () => Promise<{
        ok: boolean
        keepDays?: number
        ringMax?: number
        error?: string
      }>
    }
    files: {
      list: (opts?: { channel?: string; accountId?: number; limit?: number }) => Promise<{
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
      }>
      remove: (ids: number[]) => Promise<{ ok: boolean; removed?: number; error?: string }>
      reveal: (id: number) => Promise<{ ok: boolean; error?: string }>
      prune: (force?: boolean) => Promise<{ ok: boolean; removed?: number; error?: string }>
      policy: () => Promise<{
        ok: boolean
        autoClean?: boolean
        keepDays?: number
        maxMB?: number
        error?: string
      }>
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
      /** 取消正在跑的全量重析（按群边界停下，已扫过的群结果保留） */
      cancel: (wxid: string) => Promise<{ ok: boolean; error?: string }>
      /** 归档 N 天前已闭环记录（闭环率与趋势照旧统计，仅从活跃列表挪走） */
      archiveStale: (
        wxid: string,
        days: number
      ) => Promise<{ ok: boolean; archived?: number; error?: string }>
      /** 存量去重：合并历史锚点漂移留下的重复议题；dryRun=true 只预览方案 */
      mergeDuplicates: (
        wxid: string,
        dryRun?: boolean
      ) => Promise<{
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
      }>
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
        /** 覆盖度：truncated=true 表示单群条数上限截断（窗口比实际覆盖范围更宽） */
        coverage?: { msgs: number; truncated: boolean }
        following?: number
        closed?: number
        stalled?: number
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
      groupBadges: (
        wxid: string
      ) => Promise<{ ok: boolean; badges?: Record<string, number>; error?: string }>
      onChanged: (
        callback: (payload: {
          at?: number
          wxid?: string
          added?: number
          escalate?: number
          settled?: number
        }) => void
      ) => () => void
      /** 全量重析进度（逐群推进 + 收尾/取消） */
      onProgress: (
        callback: (payload: {
          wxid?: string
          phase?: 'group' | 'done' | 'cancelled'
          done?: number
          total?: number
          current?: string
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
      clawQrStart: (opts: {
        name: string
        baseUrl?: string
        wxid?: string
        allowUsers?: string
      }) => Promise<{
        ok: boolean
        key?: string
        qrImg?: string
        qrUrl?: string
        error?: string
      }>
      clawQrPoll: (key: string) => Promise<{
        ok: boolean
        status: 'waiting' | 'scanned' | 'confirmed' | 'expired' | 'error'
        accountId?: number
        error?: string
      }>
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
    feishuNotify: {
      get: () => Promise<
        Result<{
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
        }>
      >
      setEnabled: (on: boolean) => Promise<{ ok: boolean; error?: string }>
      setEvent: (evt: string, on: boolean) => Promise<{ ok: boolean; error?: string }>
      addTarget: (input: {
        kind: 'chat' | 'user'
        id: string
        name?: string
      }) => Promise<{ ok: boolean; error?: string }>
      removeTarget: (
        kind: 'chat' | 'user',
        id: string
      ) => Promise<{ ok: boolean; error?: string }>
      test: () => Promise<{ ok: boolean; sent?: number; error?: string }>
      listChats: () => Promise<
        Result<{ chats?: Array<{ chatId: string; name: string; chatMode: string }> }>
      >
      resolveUser: (email: string) => Promise<Result<{ openId?: string }>>
      contactScope: () => Promise<
        Result<{
          departments?: Array<{ id: string; name: string }>
          users?: Array<{ openId: string; name: string; email?: string }>
          empty?: boolean
          authUrl?: string
          appIdMasked?: string
        }>
      >
      contactDepartments: (
        parentId: string
      ) => Promise<
        Result<{ departments?: Array<{ id: string; name: string }>; hasMore?: boolean }>
      >
      contactUsers: (
        deptId: string,
        pageToken?: string
      ) => Promise<
        Result<{
          users?: Array<{ openId: string; name: string; email?: string }>
          hasMore?: boolean
          pageToken?: string
        }>
      >
      openAuthUrl: (url: string) => Promise<{ ok: boolean; error?: string }>
      /** onlyTasks=true 只看任务,false 含被拒消息(同一张 im_audit) */
      listAudit: (
        limit?: number,
        onlyTasks?: boolean
      ) => Promise<Result<{ logs?: ImAuditEntry[] }>>
    }
    lark: {
      status: () => Promise<
        Result<{
          configured?: boolean
          source?: 'config' | 'im' | 'none'
          appIdMasked?: string
          accountName?: string
          defaultUrl?: string
        }>
      >
      test: (url: string) => Promise<Result<{ text?: string }>>
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
      getWorkspace: (
        id: number
      ) => Promise<{ ok: boolean; path?: string | null; error?: string }>
      setWorkspace: (id: number, dir: string | null) => Promise<{ ok: boolean; error?: string }>
      openWorkspace: (id: number) => Promise<{ ok: boolean; error?: string }>
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
          maxOn?: number
        }>
      >
      setSkillLimit: (n: number) => Promise<{ ok: boolean; maxOn?: number; error?: string }>
      toggleSkill: (name: string, enabled: boolean) => Promise<{ ok: boolean; error?: string }>
      openSkillsDir: () => Promise<{ ok: boolean; path?: string; error?: string }>
      onEvent: (
        callback: (evt: AiChatEvent & { sessionId?: number; runId?: string }) => void
      ) => () => void
    }
    growth: {
      stats: () => Promise<Result<{ stats?: GrowthStats }>>
      listContent: (
        filter?: GrowthContentFilter
      ) => Promise<Result<{ items?: GrowthContentItem[]; total?: number }>>
      getContent: (id: number) => Promise<Result<{ item?: GrowthContentDetailView }>>
      ingestLink: (
        text: string
      ) => Promise<Result<{ item?: GrowthContentItem; existed?: boolean }>>
      patchContent: (
        id: number,
        patch: { usage?: string; status?: string; note?: string }
      ) => Promise<{ ok: boolean; error?: string }>
      removeContent: (id: number) => Promise<{ ok: boolean; error?: string }>
      listSubscriptions: () => Promise<Result<{ subscriptions?: GrowthSubscription[] }>>
      saveSubscription: (
        input: GrowthSubscriptionInput & { id?: number }
      ) => Promise<{ ok: boolean; id?: number; error?: string }>
      setSubscriptionEnabled: (
        id: number,
        enabled: boolean
      ) => Promise<{ ok: boolean; error?: string }>
      deleteSubscription: (id: number) => Promise<{ ok: boolean; error?: string }>
      runCrawl: (id: number) => Promise<Result<{ fetched?: number; inserted?: number }>>
      recentTasks: (limit?: number) => Promise<Result<{ tasks?: GrowthCrawlTaskView[] }>>
      copyClipboard: (payload: {
        text?: string
        relPath?: string
      }) => Promise<{ ok: boolean; error?: string }>
      batchPatch: (
        ids: number[],
        patch: { usage?: string; status?: string }
      ) => Promise<Result<{ updated?: number }>>
      batchRemove: (ids: number[]) => Promise<Result<{ removed?: number }>>
      uploadLocal: () => Promise<
        Result<{ added?: number; contentId?: number; skipped?: string[] }>
      >
      exportPackage: (
        id: number,
        outputIds?: number[]
      ) => Promise<Result<{ dir?: string; files?: number }>>
      redownloadMedia: (id: number) => Promise<Result<{ added?: number; failed?: number }>>
      overview: () => Promise<Result<{ overview?: GrowthOverview }>>
      configGet: () => Promise<
        Result<{ autoEnabled?: boolean; provider?: string; providerApiKey?: string }>
      >
      configSet: (
        field: 'autoEnabled' | 'provider' | 'providerApiKey',
        value: string
      ) => Promise<{ ok: boolean; error?: string }>
      onProgress: (callback: (payload: GrowthProgressPayload) => void) => () => void
    }

    growthai: {
      listTasks: () => Promise<Result<{ tasks?: unknown[] }>>
      getTask: (
        id: number
      ) => Promise<Result<{ task?: unknown; outputs?: unknown[]; candidates?: unknown[] }>>
      createTask: (input: {
        contentId: number
        storeId?: number | null
        goal?: string
      }) => Promise<{
        ok: boolean
        taskId?: number
        sessionId?: number
        error?: string
      }>
      updateTask: (
        id: number,
        patch: Record<string, unknown>
      ) => Promise<{ ok: boolean; error?: string }>
      deleteTask: (id: number) => Promise<{ ok: boolean; error?: string }>
      messages: (id: number) => Promise<Result<{ messages?: unknown[] }>>
      sendMessage: (
        id: number,
        text: string,
        images?: string[]
      ) => Promise<{ ok: boolean; error?: string }>
      stop: (id: number) => Promise<{ ok: boolean }>
      running: (id: number) => Promise<{ ok: boolean; running?: boolean }>
      resolveCandidate: (
        taskId: number,
        outputId: number,
        action: 'select' | 'archive' | 'delete'
      ) => Promise<{ ok: boolean; error?: string }>
      revertOutput: (outputId: number) => Promise<{ ok: boolean; error?: string }>
      listStores: () => Promise<Result<{ stores?: unknown[] }>>
      saveStore: (
        input: Record<string, unknown>
      ) => Promise<{ ok: boolean; id?: number; error?: string }>
      removeStore: (id: number) => Promise<{ ok: boolean; error?: string }>
      getBrand: () => Promise<Result<{ brand?: unknown }>>
      saveBrand: (
        name: string,
        profile: string
      ) => Promise<{ ok: boolean; id?: number; error?: string }>
      configGet: () => Promise<Result<{ image?: unknown; search?: unknown }>>
      configSet: (field: string, value: string) => Promise<{ ok: boolean; error?: string }>
      testImage: () => Promise<{ ok: boolean; error?: string }>
    }
    growthbuzz: {
      overview: (storeId?: number | null) => Promise<Result<{ overview?: GrowthBuzzOverview }>>
      list: (
        filter: GrowthBuzzFilter
      ) => Promise<Result<{ items?: GrowthBuzzMentionView[]; total?: number }>>
      detail: (id: number) => Promise<Result<GrowthBuzzDetailView>>
      addLink: (input: {
        storeId?: number | null
        text: string
      }) => Promise<GrowthBuzzAddResult>
      addComments: (input: {
        mentionId: number
        raw: string
        source?: string
      }) => Promise<GrowthBuzzCommentsResult>
      diagnose: (
        id: number,
        useModel?: boolean
      ) => Promise<
        Result<{ diagnosis?: GrowthBuzzDiagnosisView; mention?: GrowthBuzzMentionView }>
      >
      diagnoseBatch: (
        ids: number[],
        useModel?: boolean
      ) => Promise<Result<{ succeeded?: number; failed?: number }>>
      update: (
        id: number,
        patch: Record<string, unknown>
      ) => Promise<Result<{ mention?: GrowthBuzzMentionView }>>
      remove: (id: number) => Promise<{ ok: boolean; error?: string }>
      removeComment: (id: number) => Promise<{ ok: boolean; error?: string }>
      openUrl: (url: string) => Promise<{ ok: boolean; error?: string }>
      toWorkbench: (
        id: number
      ) => Promise<Result<{ taskId?: number; contentId?: number; existed?: boolean }>>
    }
    report: {
      list: () => Promise<Result<{ jobs?: ReportJobInfo[] }>>
      save: (input: ReportJobInput) => Promise<{ ok: boolean; id?: number; error?: string }>
      remove: (id: number) => Promise<{ ok: boolean; error?: string }>
      setEnabled: (id: number, enabled: boolean) => Promise<{ ok: boolean; error?: string }>
      runNow: (id: number) => Promise<{ ok: boolean; summary?: string; error?: string }>
      cancel: (id: number) => Promise<{ ok: boolean; error?: string }>
      onProgress: (
        callback: (payload: {
          jobId: number
          running: boolean
          phase?: 'sessions' | 'media' | 'done'
          status?: string
          summary?: string
          total?: number
          done?: number
          added?: number
          elapsedMs?: number
        }) => void
      ) => () => void
      testConn: (opts: {
        target?: ReportPgTarget
        jobId?: number
      }) => Promise<{ ok: boolean; error?: string }>
      history: (id: number) => Promise<Result<{ runs?: ReportRunInfo[] }>>
    }
}
