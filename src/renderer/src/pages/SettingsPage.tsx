import { useEffect, useState } from 'react'
import type { SendStatusInfo } from '../../../shared/types'
import { APP_NAME } from '../../../shared/appInfo'
import WechatKeySection from '../components/settings/WechatKeySection'
import CryptoCenterSection from '../components/settings/CryptoCenterSection'
import AgentSettingsSection from '../components/settings/AgentSettingsSection'
import { agentFormDirty } from '../components/settings/agentDirty'
import WorkbenchApprovalSection from '../components/settings/WorkbenchApprovalSection'
import WorkbenchMemoSection from '../components/settings/WorkbenchMemoSection'
import { WorkbenchWorkspaceSection } from '../components/settings/WorkbenchWorkspaceSection'
import WorkbenchReliabilitySection from '../components/settings/WorkbenchReliabilitySection'
import AiRunPanel from '../components/settings/AiRunPanel'
import { FeishuNotifySection } from '../components/settings/FeishuNotifySection'
import WorkbenchSkillsSection from '../components/settings/WorkbenchSkillsSection'
import ReportJobsSection from '../components/settings/ReportJobsSection'
import { LogSection } from '../components/settings/LogSection'
import { LarkBaseSyncSection } from '../components/settings/LarkBaseSyncSection'
import {
  AdvancedBlock,
  FieldRow,
  PillRow,
  SettingsCard,
  StatusPill,
  SwitchRow
} from '../components/settings/ui'
import { ImSection } from './ImPage'
import { toast } from '../stores/toast'
import { confirmAsk } from '../stores/confirmDialog'
import { useWorkbenchStore } from '../stores/workbench'
import { setIssueAlertPref } from '../lib/issueAlert'
import { readThemeMode, setThemeMode } from '../lib/appearance'
import type { ThemeMode } from '../../../shared/theme'
import './settings.css'

/**
 * 设置页：微信数据与密钥 / AI 通道 / 发送频控 / 注入开关 / 熔断复位。
 * 配置真实读写主进程 app_config（cs:config），保存即生效。
 */

interface FormState {
  'ai.enabled': string
  'ai.provider': string
  'ai.baseUrl': string
  'ai.apiKey': string
  'ai.model': string
  'ai.agent': string
  'ai.maxOutputTokens': string
  'send.dailyLimit': string
  'send.humanizeDelay': string
  'send.sessionBurstWindowSec': string
  'send.dupMaxSessions': string
  'inject.enabled': string
  'notify.enabled': string
  'lark.appId': string
  'lark.appSecret': string
  'lark.defaultUrl': string
}

/** AI 通道预设（OpenAI 兼容 chat/completions）：仅预置官方接口地址；模型名不预置，通过「获取模型」拉取或手动填写 */
interface AiPreset {
  id: string
  label: string
  baseUrl: string
}

const AI_PRESETS: AiPreset[] = [
  {
    id: 'openai',
    label: 'OpenAI',
    baseUrl: 'https://api.openai.com/v1'
  },
  {
    id: 'deepseek',
    label: 'DeepSeek（深度求索）',
    baseUrl: 'https://api.deepseek.com/v1'
  },
  {
    id: 'dashscope',
    label: '阿里云百炼（通义千问）',
    baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1'
  },
  {
    id: 'zhipu',
    label: '智谱 AI（GLM）',
    baseUrl: 'https://open.bigmodel.cn/api/paas/v4'
  },
  {
    id: 'moonshot',
    label: 'Moonshot（Kimi）',
    baseUrl: 'https://api.moonshot.cn/v1'
  },
  {
    id: 'siliconflow',
    label: '硅基流动 SiliconFlow',
    baseUrl: 'https://api.siliconflow.cn/v1'
  },
  {
    id: 'volcengine',
    label: '火山方舟（豆包）',
    baseUrl: 'https://ark.cn-beijing.volces.com/api/v3'
  },
  {
    id: 'ollama',
    label: 'Ollama（本地）',
    baseUrl: 'http://localhost:11434/v1'
  },
  {
    id: 'custom',
    label: '自定义（OpenAI 兼容）',
    baseUrl: ''
  }
]

const DEFAULTS: FormState = {
  'ai.enabled': '0',
  'ai.provider': 'openai',
  'ai.baseUrl': 'https://api.openai.com/v1',
  'ai.apiKey': '',
  'ai.model': '',
  'ai.agent': '1',
  // 0 = 未配置（按各调用点的默认值 + 思考型模型自动抬升）
  'ai.maxOutputTokens': '0',
  'send.dailyLimit': '200',
  'send.humanizeDelay': '1',
  'send.sessionBurstWindowSec': '90',
  'send.dupMaxSessions': '20',
  'inject.enabled': '1',
  'notify.enabled': '1',
  'lark.appId': '',
  'lark.appSecret': '',
  'lark.defaultUrl': ''
}

const configApi = window.api?.cs?.config
const replyApi = window.api?.cs?.reply
const appApi = window.api?.cs?.app
const aiApi = window.api?.cs?.ai

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`
}

/** 新问题提示音开关(设置 → 偏好与数据 → 通用;配置 monitor.alertSound,默认开) */
function IssueSoundRow(): React.JSX.Element {
  const [on, setOn] = useState(true)
  useEffect(() => {
    let alive = true
    window.api?.cs?.config
      ?.getAll()
      .then((all) => {
        if (alive) setOn((all['monitor.alertSound'] ?? '1') !== '0')
      })
      .catch(() => undefined)
    return () => {
      alive = false
    }
  }, [])
  const change = (v: boolean): void => {
    setOn(v)
    setIssueAlertPref(v)
    void window.api?.cs?.config?.set('monitor.alertSound', v ? '1' : '0')
    toast.success(v ? '已开启新问题提示音' : '已关闭新问题提示音')
  }
  return (
    <SwitchRow
      label="新问题提示音"
      desc="后台巡检/分析发现新问题(新增条数>0)时播放提示音;在任意页面、窗口聚焦与否均生效。"
      checked={on}
      onChange={change}
    />
  )
}

/** 设置页 Tab 板块 */
type SettingsTab = 'wechat' | 'ai' | 'send' | 'other' | 'im' | 'workbench' | 'report' | 'logs'

const SETTINGS_TAB_KEYS: readonly SettingsTab[] = [
  'wechat',
  'ai',
  'send',
  'other',
  'im',
  'workbench',
  'report',
  'logs'
]
/** 记住上次所选 Tab（localStorage，首次进入默认「微信数据」） */
const SETTINGS_TAB_KEY = 'cs.settingsTab'

function SettingsPage(): React.JSX.Element {
  const setPage = useWorkbenchStore((s) => s.setPage)
  const setGrowthTab = useWorkbenchStore((s) => s.setGrowthTab)
  /** 外观主题：真源在 lib/appearance（localStorage），这里留一份 state 只为了让按钮选中态刷新 */
  const [themeMode, setThemeModeState] = useState<ThemeMode>(() => readThemeMode())
  const [tab, setTab] = useState<SettingsTab>(() => {
    const saved = localStorage.getItem(SETTINGS_TAB_KEY)
    return (SETTINGS_TAB_KEYS as readonly string[]).includes(saved as string)
      ? (saved as SettingsTab)
      : 'wechat'
  })
  const [form, setForm] = useState<FormState>(DEFAULTS)
  const [loaded, setLoaded] = useState(false)
  const [savedTip, setSavedTip] = useState('')
  const [sendStatus, setSendStatus] = useState<SendStatusInfo | null>(null)
  const [aiTesting, setAiTesting] = useState(false)
  /** 飞书凭证状态：只保留「配没配 / 复用谁」这类人话信息，App ID 之类的标识不再往界面上带 */
  const [larkStatus, setLarkStatus] = useState<{
    configured: boolean
    source: 'config' | 'im' | 'none'
    accountName?: string
    defaultUrl: string
  } | null>(null)
  const [larkTesting, setLarkTesting] = useState(false)
  /** 已配置后是否展开凭证表单（默认收起，界面上只显示一句状态） */
  const [larkReconfig, setLarkReconfig] = useState(false)
  const [larkTestRes, setLarkTestRes] = useState<{ ok: boolean; text: string } | null>(null)
  /** 飞书凭证状态刷新计数(保存配置后 +1 重新读取) */
  const [larkReload, setLarkReload] = useState(0)
  /** AI 运行与成本的范围：'run'=本次运行(内存态) / 数字=近 N 天(落库) */
  const [aiCostScope, setAiCostScope] = useState<'run' | 1 | 7 | 30>(7)
  useEffect(() => {
    let alive = true
    void window.api?.cs?.lark
      ?.status()
      .then((res) => {
        if (!alive || !res?.ok) return
        setLarkStatus({
          configured: !!res.configured,
          source: res.source ?? 'none',
          accountName: res.accountName,
          defaultUrl: res.defaultUrl ?? ''
        })
      })
      .catch(() => undefined)
    return () => {
      alive = false
    }
  }, [larkReload])

  const [aiTestRes, setAiTestRes] = useState<{
    ok: boolean
    latencyMs?: number
    error?: string
  } | null>(null)
  const [aiModelsLoading, setAiModelsLoading] = useState(false)
  const [aiModels, setAiModels] = useState<string[]>([])
  const [aiModelsMsg, setAiModelsMsg] = useState<{ ok: boolean; text: string } | null>(null)
  /** true 时模型名称为自由文本输入（自定义/手动填模型）；false 为下拉选择 */
  const [modelFree, setModelFree] = useState(false)
  const [cacheEffective, setCacheEffective] = useState<{
    path: string
    defaultPath: string
    isDefault: boolean
  } | null>(null)
  const [autoLaunch, setAutoLaunch] = useState(false)
  const [dataStats, setDataStats] = useState<{ dbBytes: number; cacheBytes: number } | null>(null)
  const [clearArmed, setClearArmed] = useState(false)
  const [version, setVersion] = useState('')
  // 问题监控口径(小时):积压超时 / 跟进超时
  const [backlogHours, setBacklogHours] = useState(48)
  const [followUpHours, setFollowUpHours] = useState(12)
  // 静默收尾阈值(小时；0 = 关闭该策略)
  const [autoCloseHours, setAutoCloseHours] = useState(72)
  // 已指派未闭环盯办阈值(小时)
  const [escalateAssignedHours, setEscalateAssignedHours] = useState(8)
  // 高置信重复议题自动合并(默认开)
  const [autoMergeIssue, setAutoMergeIssue] = useState(true)
  // 后台自动增量分析(全部活跃群,不限于当前打开的群;默认开)
  const [autoScanIssue, setAutoScanIssue] = useState(true)
  // 盯办提醒(未指派超时/跟进超时升级;默认开)
  const [escalateIssue, setEscalateIssue] = useState(true)
  // 智能体发送微信消息:总开关与逐次审批(默认均开)
  const [agentSendEnabled, setAgentSendEnabled] = useState(true)
  const [agentSendApprove, setAgentSendApprove] = useState(true)

  /** 刷新缓存目录状态（生效目录/默认目录；effect 与路径变更共用） */
  const refreshCachePath = async (): Promise<void> => {
    const r = await configApi?.cachePath().catch(() => null)
    if (r?.ok && r.path && r.defaultPath) {
      setCacheEffective({ path: r.path, defaultPath: r.defaultPath, isDefault: !!r.isDefault })
    }
  }

  /** 刷新本地库/缓存占用统计（effect 与清理缓存后共用） */
  const refreshDataStats = async (): Promise<void> => {
    const r = await appApi?.dataStats().catch(() => null)
    if (r?.ok && r.dbBytes !== undefined && r.cacheBytes !== undefined) {
      setDataStats({ dbBytes: r.dbBytes, cacheBytes: r.cacheBytes })
    }
  }

  useEffect(() => {
    void configApi?.getAll().then((cfg) => {
      setForm((prev) => {
        const next = { ...prev }
        for (const k of Object.keys(next) as Array<keyof FormState>) {
          if (cfg[k] !== undefined && cfg[k] !== '') next[k] = cfg[k]
        }
        // 旧配置没有 ai.provider 时按已存 baseUrl 反推通道，避免下拉与地址不一致
        if (cfg['ai.provider'] === undefined && cfg['ai.baseUrl']) {
          const saved = cfg['ai.baseUrl'].trim().replace(/\/+$/, '')
          const hit = AI_PRESETS.find((p) => p.baseUrl === saved)
          if (hit) next['ai.provider'] = hit.id
        }
        return next
      })
      // 问题监控口径(小时)
      const hours = (v: string | undefined, fb: number): number => {
        const n = Number(v)
        return Number.isFinite(n) && n > 0 ? Math.floor(n) : fb
      }
      setBacklogHours(hours(cfg['monitor.backlogHours'], 48))
      setFollowUpHours(hours(cfg['monitor.followUpHours'], 12))
      // 自动收尾允许 0（=关闭），不能用上面的 hours()（它把 0 当非法值回落默认）
      const acRaw = Number(cfg['monitor.autoCloseHours'])
      setAutoCloseHours(
        cfg['monitor.autoCloseHours'] !== undefined && Number.isFinite(acRaw) && acRaw >= 0
          ? Math.floor(acRaw)
          : 72
      )
      setEscalateAssignedHours(hours(cfg['issue.escalateAssignedHours'], 8))
      setAutoScanIssue(cfg['issue.autoScan.enabled'] !== '0')
      setEscalateIssue(cfg['issue.escalate.enabled'] !== '0')
      setAutoMergeIssue(cfg['issue.autoMergeDuplicates'] !== '0')
      setAgentSendEnabled(cfg['send.agentEnabled'] !== '0')
      setAgentSendApprove(cfg['send.approve'] !== '0')
      setLoaded(true)
    })
    void replyApi
      ?.getSendStatus()
      .then(setSendStatus)
      .catch(() => undefined)
    // eslint-disable-next-line react-hooks/set-state-in-effect -- 挂载时一次性刷新缓存目录展示（异步回调后 setState）
    void refreshCachePath()
    void appApi?.getAutoLaunch().then((r) => setAutoLaunch(!!r?.enabled))
    void appApi?.info().then((r) => setVersion(r?.version ?? ''))
    void refreshDataStats()
  }, [])

  /** 路径是否相同（忽略末尾分隔符与大小写，Windows 路径不区分大小写） */
  const samePath = (a: string, b: string): boolean =>
    a.replace(/\\+$/, '').toLowerCase() === b.replace(/\\+$/, '').toLowerCase()

  /** 应用缓存目录配置并刷新状态：对话框选完/恢复默认后即保存生效 */
  const applyCachePath = async (dir: string): Promise<void> => {
    const dir2 = dir.trim()
    // 恰好选回默认目录时归一化为空配置，保持「默认目录」展示
    const final = dir2 && cacheEffective && samePath(dir2, cacheEffective.defaultPath) ? '' : dir2
    if (cacheEffective && !cacheEffective.isDefault && samePath(final, cacheEffective.path)) return
    await configApi?.set('cache.path', final)
    await refreshCachePath()
    toast.success(final ? '缓存目录已更新' : '已恢复默认缓存目录')
  }

  /** 浏览：对话框从当前生效缓存目录定位（不存在时主进程向上回退） */
  const browseCachePath = async (): Promise<void> => {
    const r = await window.api?.cs?.dialog?.pickDirectory('选择数据缓存目录', cacheEffective?.path)
    if (r?.ok && r.path) void applyCachePath(r.path)
  }

  const resetCachePath = async (): Promise<void> => {
    await applyCachePath('')
  }

  /** 保存口径阈值(失焦/回车)：非法值回落默认并回填输入框；静默收尾允许 0(=关闭策略) */
  const saveThreshold = (
    key:
      | 'monitor.backlogHours'
      | 'monitor.followUpHours'
      | 'monitor.autoCloseHours'
      | 'issue.escalateAssignedHours',
    value: number,
    fallback: number,
    apply: (v: number) => void
  ): void => {
    const min = key === 'monitor.autoCloseHours' ? 0 : 1
    if (!Number.isFinite(value) || value < min || value > 24 * 30) {
      apply(fallback)
      toast.error(
        min === 0 ? '请输入 0~720 之间的整数小时(0 = 关闭)' : '请输入 1~720 之间的整数小时'
      )
      return
    }
    void configApi?.set(key, String(Math.floor(value)))
    toast.success('口径已保存(监控与群问题面板即时生效)')
  }

  const toggleAutoLaunch = async (enabled: boolean): Promise<void> => {
    const r = await appApi?.setAutoLaunch(enabled).catch(() => null)
    setAutoLaunch(!!r?.enabled)
  }

  /** 清理缓存：两次点击确认（第一次进入确认态，3s 不点自动取消） */
  const clearCache = async (): Promise<void> => {
    if (!clearArmed) {
      setClearArmed(true)
      setTimeout(() => setClearArmed(false), 3000)
      return
    }
    setClearArmed(false)
    const r = await appApi?.clearCache().catch(() => null)
    if (r?.ok) {
      toast.success('缓存已清理')
      void refreshDataStats()
    } else {
      toast.error(r?.error || '清理失败')
    }
  }

  const patch = (key: keyof FormState, value: string): void => {
    setForm((prev) => ({ ...prev, [key]: value }))
  }

  /** 飞书云文档: 用表单里的链接实测能否读到(失败信息含权限修复指引) */
  const testLark = async (): Promise<void> => {
    const api = window.api?.cs?.lark
    if (!api?.test) return
    const url = (form['lark.defaultUrl'] || larkStatus?.defaultUrl || '').trim()
    if (!url) {
      setLarkTestRes({
        ok: false,
        text: '请先填写飞书链接(如 https://xxx.feishu.cn/base/…?table=…)'
      })
      return
    }
    setLarkTesting(true)
    try {
      const res = await api.test(url)
      setLarkTestRes(
        res.ok ? { ok: true, text: res.text ?? '' } : { ok: false, text: res.error ?? '测试失败' }
      )
    } finally {
      setLarkTesting(false)
    }
  }

  /** 切换设置 Tab 并记忆选择（下次进入直接定位） */
  const switchTab = (key: SettingsTab): void => {
    const go = (): void => {
      setTab(key)
      try {
        localStorage.setItem(SETTINGS_TAB_KEY, key)
      } catch {
        /* localStorage 不可用（隐私模式等）时仅本次生效 */
      }
    }
    // 人设存在未保存修改时先确认,避免切换板块丢失编辑
    if (key !== tab && agentFormDirty()) {
      void confirmAsk({
        title: '切换设置板块',
        message: '智能体人设还有未保存的修改,切换板块将丢失。确定继续?',
        confirmText: '仍要切换'
      }).then((ok) => {
        if (ok) go()
      })
      return
    }
    go()
  }

  /** 保存反馈：统一在标题下方闪一下，替代每个卡片各自的「保存」按钮 */
  const flashSaved = (): void => {
    setSavedTip('已保存')
    window.setTimeout(() => setSavedTip(''), 1500)
  }

  /**
   * 开关 / 下拉：一次操作就是一次完整决定 → **立即落库**。
   * （此前同一张卡里开关要"保存"才生效、旁边开关却即时生效，用户无法预判。）
   */
  const setNow = (key: keyof FormState, value: string): void => {
    patch(key, value)
    if (!configApi || !loaded) return
    void configApi.set(key, value)
    flashSaved()
  }

  /**
   * 输入框：**失焦 / 回车落库**。
   * 不用 onChange 直写：半截输入（https://api.）不该被当成配置存进去。
   */
  const saveField = (key: keyof FormState, value: string): void => {
    patch(key, value)
    if (!configApi || !loaded) return
    void configApi.set(key, value)
    flashSaved()
  }

  /** 营销 AI（生图/搜索）已搬到营销页，这里只留一个入口，不再重复一份配置 */
  const goMarketingAi = (): void => {
    setGrowthTab('provider')
    setPage('growth')
  }

  /** 飞书凭证：失焦即存，同时刷新顶部状态胶囊（连接状态取决于两个字段，存完就重算） */
  const saveLarkField = (
    key: 'lark.appId' | 'lark.appSecret' | 'lark.defaultUrl',
    value: string
  ): void => {
    patch(key, value)
    if (!configApi || !loaded) return
    void configApi.set(key, value).then(() => setLarkReload((n) => n + 1))
    flashSaved()
  }

  const resetCircuit = async (): Promise<void> => {
    await replyApi?.resetCircuit()
    const s = await replyApi?.getSendStatus().catch(() => null)
    setSendStatus(s ?? null)
  }

  /** 选择通道预设：仅自动填充官方接口地址（模型名不预置，留空待「获取模型」或手动填写） */
  const pickAiProvider = (id: string): void => {
    // 通道切换后清空上次拉取的模型列表与当前模型名，避免串入上一通道的值
    setAiModels([])
    setAiModelsMsg(null)
    // 自定义通道无预置地址 → 直接进入自由输入；其它通道用下拉选择
    setModelFree(id === 'custom')
    const preset = AI_PRESETS.find((p) => p.id === id)
    setNow('ai.provider', id)
    setNow('ai.model', '')
    setNow('ai.baseUrl', preset ? preset.baseUrl : '')
  }

  /** 用当前表单值（无需先保存）拉取该通道可用模型并列入下拉 */
  const fetchAiModels = async (): Promise<void> => {
    if (!aiApi) return
    setAiModelsLoading(true)
    setAiModelsMsg(null)
    try {
      const r = await aiApi.models({
        baseUrl: form['ai.baseUrl'].trim(),
        apiKey: form['ai.apiKey'].trim()
      })
      if (r?.ok && r.models && r.models.length > 0) {
        setAiModels(r.models)
        setModelFree(false)
        // 模型名空（自定义等未填）才自动选第一个；已填模型尊重用户手动输入，不覆盖
        const current = form['ai.model'].trim()
        if (!current || !r.models.includes(current)) patch('ai.model', r.models[0])
        setAiModelsMsg({
          ok: true,
          text: current
            ? `已获取 ${r.models.length} 个模型，保留当前填写（可下拉切换）`
            : `已获取 ${r.models.length} 个模型，默认选中第一个，可下拉切换`
        })
      } else {
        setAiModelsMsg({ ok: false, text: r?.error ?? '获取模型失败' })
      }
    } catch (e) {
      setAiModelsMsg({ ok: false, text: e instanceof Error ? e.message : '获取模型失败' })
    } finally {
      setAiModelsLoading(false)
    }
  }

  /** 用当前表单值（无需先保存）测试 OpenAI 兼容通道 */
  const testAi = async (): Promise<void> => {
    if (!aiApi) return
    setAiTesting(true)
    setAiTestRes(null)
    try {
      const r = await aiApi.test({
        baseUrl: form['ai.baseUrl'].trim(),
        apiKey: form['ai.apiKey'].trim(),
        model: form['ai.model'].trim()
      })
      setAiTestRes(r ?? { ok: false, error: '测试调用失败' })
    } catch (e) {
      setAiTestRes({ ok: false, error: e instanceof Error ? e.message : '测试调用失败' })
    } finally {
      setAiTesting(false)
    }
  }

  const boolVal = (v: string): boolean => v === '1' || v === 'true'
  const boolStr = (b: boolean): string => (b ? '1' : '0')

  // 模型下拉候选：远程获取模型 ∪ 当前已填值（保证已选项可见；不预置任何模型名）
  const modelCandidates = Array.from(
    new Set([...aiModels, form['ai.model']].filter((m) => typeof m === 'string' && m.trim() !== ''))
  ) as string[]

  return (
    <div className="page-scroll">
      <h2 className="page-title">设置</h2>
      <div className="page-subtitle">
        开关与下拉即时生效，输入框失焦即存{' '}
        {savedTip && <span className="st-saved">{savedTip}</span>}
        {!loaded && '（加载中…）'}
      </div>

      {/* Tab 导航（按板块切换，减少拥挤） */}
      <div className="st-tabs" role="tablist" aria-label="设置板块">
        {(
          [
            ['wechat', '微信数据'],
            // 「AI 助手」= 模型通道与它能看到的东西（飞书文档/Base）；「AI 工作台」= 工作台自己的行为
            // （人设/备忘/工作区/审批/技能）。此前两者混在一个 tab 里，11 张卡单列长滚动。
            ['ai', 'AI 助手'],
            ['workbench', 'AI 工作台'],
            ['send', '发送与频控'],
            ['im', 'IM 渠道'],
            ['other', '偏好与数据'],
            ['report', '定时任务'],
            ['logs', '日志']
          ] as Array<[SettingsTab, string]>
        ).map(([key, label]) => (
          <button
            key={key}
            type="button"
            role="tab"
            aria-selected={tab === key}
            className={`st-tab${tab === key ? ' is-active' : ''}`}
            onClick={() => switchTab(key)}
          >
            {label}
          </button>
        ))}
      </div>

      {tab === 'im' && (
        <div className="st-tab-panel">
          <ImSection onOpenNotifications={() => switchTab('other')} />
        </div>
      )}

      {tab === 'workbench' && (
        <div className="st-tab-panel">
          {/* AI 工作台自己的行为：人设 / 备忘 / 工作区 / 审批 / 技能（技能此前单独占一个 tab，只有一张卡） */}
          <SettingsCard
            title="智能体(统一人设)"
            desc="全应用统一使用同一条人设:智能分析(群问题/工作台)与智能回复(回复建议/IM 通道)都按此人设组织口径与话术,修改后即时生效。"
          >
            <AgentSettingsSection />
          </SettingsCard>

          <SettingsCard
            title="运营备忘"
            desc="跨会话动态事实:工作台分析、回复建议与 IM 自动回复每轮都会携带。"
          >
            <WorkbenchMemoSection />
          </SettingsCard>

          <SettingsCard
            title="默认工作区"
            desc="飞书机器人 / 微信 ClawBot 这类没有工作台界面的会话,用它作为文件工具的根目录;工作台会话单独绑定的目录优先。"
          >
            <WorkbenchWorkspaceSection />
          </SettingsCard>

          <SettingsCard
            title="工具审批策略"
            desc="写操作(代发消息、改问题状态、写文件等)的审批偏好:人工审批 / 完全访问;命中「始终允许」名单的工具不再询问。"
          >
            <WorkbenchApprovalSection />
          </SettingsCard>

          <SettingsCard
            title="业务技能(SKILL.md)"
            desc="把可复用的口径写成技能文件，AI 按技能回答；启用上限与注入预算成正比。"
          >
            <WorkbenchSkillsSection />
          </SettingsCard>
        </div>
      )}

      {tab === 'report' && (
        <div className="st-tab-panel">
          <ReportJobsSection />
        </div>
      )}

      {tab === 'logs' && (
        <div className="st-tab-panel">
          <LogSection />
        </div>
      )}

      {tab === 'wechat' && (
        <div className="st-tab-panel">
          <WechatKeySection />
          <CryptoCenterSection />
        </div>
      )}

      {tab === 'ai' && (
        <div className="st-tab-panel">
          {/* 指路：营销 AI 的通道与策略不在这里重复一份，去营销页和门店档案放一起配 */}
          <div className="st-actions">
            <span className="st-hint">
              营销相关的 AI（AI 生图）已移到「营销 → 设置」，与门店/品牌档案同屏。
            </span>
            <button type="button" className="ui-btn is-sm" onClick={goMarketingAi}>
              去设置
            </button>
          </div>
          {/* AI 通道(独占一行) */}
          <SettingsCard
            title="AI 通道配置(OpenAI 兼容)"
            desc="选择通道会自动填入官方接口地址(火山方舟需在控制台创建推理接入点后填写 ep-xxx);模型名可点「获取模型」拉取或手动填写。改动即时保存,建议先「测试连接」验证。思考型模型(DeepSeek Reasoner/Qwen 思考/GLM-Z 等)会把思考算进输出预算,预算不足时会出现「思考完了却没有正文」,可在此调高或改用非思考模型。"
          >
            <SwitchRow
              label="启用 AI 调用"
              desc="关闭后回复建议不产出候选、群问题提取走本地规则降级。"
              checked={boolVal(form['ai.enabled'])}
              onChange={(v) => setNow('ai.enabled', boolStr(v))}
            />
            <FieldRow label="通道">
              <select
                className="st-input"
                value={form['ai.provider']}
                onChange={(e) => pickAiProvider(e.target.value)}
              >
                {AI_PRESETS.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.label}
                  </option>
                ))}
              </select>
            </FieldRow>
            <FieldRow label="接口地址(Base URL)">
              <input
                className="st-input"
                value={form['ai.baseUrl']}
                onChange={(e) => patch('ai.baseUrl', e.target.value)}
                onBlur={(e) => saveField('ai.baseUrl', e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') saveField('ai.baseUrl', e.currentTarget.value)
                }}
                placeholder="https://api.openai.com/v1"
              />
            </FieldRow>
            <FieldRow label="API Key">
              <input
                className="st-input"
                type="password"
                value={form['ai.apiKey']}
                onChange={(e) => patch('ai.apiKey', e.target.value)}
                onBlur={(e) => saveField('ai.apiKey', e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') saveField('ai.apiKey', e.currentTarget.value)
                }}
                placeholder="sk-..."
              />
            </FieldRow>
            <FieldRow label="模型名称">
              <span className="st-mrow">
                {modelFree ? (
                  <input
                    className="st-input"
                    value={form['ai.model']}
                    onChange={(e) => patch('ai.model', e.target.value)}
                    onBlur={(e) => saveField('ai.model', e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') saveField('ai.model', e.currentTarget.value)
                    }}
                    placeholder={
                      form['ai.provider'] === 'custom' ? '输入任意 OpenAI 兼容模型名' : '模型名'
                    }
                  />
                ) : (
                  <select
                    className="st-input"
                    value={modelCandidates.includes(form['ai.model']) ? form['ai.model'] : ''}
                    onChange={(e) => {
                      if (e.target.value === '__manual__') {
                        setModelFree(true)
                      } else {
                        setNow('ai.model', e.target.value)
                      }
                    }}
                  >
                    {modelCandidates.length === 0 && (
                      <option value="" disabled>
                        （暂无模型，可点右侧「获取模型」或手动输入）
                      </option>
                    )}
                    {modelCandidates.map((m) => (
                      <option key={`model-opt-${m}`} value={m}>
                        {m}
                      </option>
                    ))}
                    <option value="__manual__">✍️ 手动输入模型…</option>
                  </select>
                )}
                {modelFree && modelCandidates.length > 0 && (
                  <button
                    type="button"
                    className="ui-btn"
                    onClick={() => setModelFree(false)}
                    title="从下拉列表选择模型"
                  >
                    列表选择
                  </button>
                )}
                <button
                  type="button"
                  className="ui-btn"
                  disabled={aiModelsLoading || !form['ai.baseUrl'].trim()}
                  onClick={() => void fetchAiModels()}
                  title="调用 {Base URL}/models 拉取当前通道可用模型"
                >
                  {aiModelsLoading ? '获取中…' : '获取模型'}
                </button>
              </span>
            </FieldRow>
            <div className="st-model-msg">
              {aiModelsMsg &&
                (aiModelsMsg.ok ? (
                  <span className="st-ok">✓ {aiModelsMsg.text}</span>
                ) : (
                  <span className="st-bad">✗ {aiModelsMsg.text}</span>
                ))}
            </div>
            <div className="st-actions">
              <button
                type="button"
                className="ui-btn"
                disabled={aiTesting}
                onClick={() => void testAi()}
              >
                {aiTesting ? '测试中…' : '测试连接'}
              </button>
              {!loaded && <span className="st-hint">配置加载中…</span>}
            </div>
            <FieldRow
              label="输出预算(tokens)"
              hint="单次回复最多生成多少 token。思考型模型的思考过程也算在里面，太小会出现「想完了但一个字没写」；0 = 自动（按模型类型给，思考型自动抬到 8192 并在失败后放大重试）"
            >
              <input
                className="st-input"
                type="number"
                min={0}
                max={200000}
                value={form['ai.maxOutputTokens'] ?? '0'}
                onChange={(e) => patch('ai.maxOutputTokens', e.target.value)}
                onBlur={(e) => saveField('ai.maxOutputTokens', e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') saveField('ai.maxOutputTokens', e.currentTarget.value)
                }}
              />
            </FieldRow>
            <SwitchRow
              label="业务上下文增强"
              desc="生成建议时自动带上本群待处理问题与团队客服背景;模型必要时可调用只读工具(查历史问题/团队名单)再作答。关闭则仅用聊天记录。"
              checked={boolVal(form['ai.agent'])}
              onChange={(v) => setNow('ai.agent', boolStr(v))}
            />
            <div className="st-ai-test">
              {aiTestRes &&
                (aiTestRes.ok ? (
                  <span className="st-ok">✓ 连接成功 · {aiTestRes.latencyMs} ms</span>
                ) : (
                  <span className="st-bad">✗ {aiTestRes.error}</span>
                ))}
            </div>
          </SettingsCard>

          {/* AI 运行与成本(一张卡两种范围,替代此前"可靠性"+"成本"两张语义重叠的卡) */}
          <SettingsCard
            title="AI 运行与成本"
            desc="每次真实模型调用的成功率、失败原因与 token 用量。「本次运行」是内存态、重启清零、只覆盖工作台;按天数则是落库记录,覆盖所有模块(含后台群问题分析与数字员工值班)。"
          >
            <div className="st-actions">
              {(['run', 1, 7, 30] as const).map((s) => (
                <button
                  key={String(s)}
                  type="button"
                  className={'ui-btn is-sm' + (aiCostScope === s ? ' is-primary' : '')}
                  onClick={() => setAiCostScope(s)}
                >
                  {s === 'run' ? '本次运行' : String(s) + ' 天'}
                </button>
              ))}
            </div>
            {aiCostScope === 'run' ? (
              <WorkbenchReliabilitySection />
            ) : (
              <AiRunPanel days={aiCostScope} />
            )}
          </SettingsCard>

          <SettingsCard
            title="飞书云文档(读取多维表格/文档)"
            desc="让 AI 能读飞书多维表格(Base)与云文档: 把 /base/ 或 /docx/ 链接发给 AI 即可。只读, 不会修改飞书里的数据。App ID / Secret 留空则自动复用 IM 渠道里的飞书机器人账号。"
          >
            {/* 凭证细节默认收起:配好之后界面上只留一句人话状态 + 动作按钮 */}
            <PillRow>
              <StatusPill
                tone={larkStatus?.configured ? 'ok' : 'off'}
                text={
                  larkStatus === null
                    ? '读取中…'
                    : larkStatus.configured
                      ? larkStatus.source === 'im'
                        ? `已连接（复用 IM 账号「${larkStatus.accountName ?? '飞书机器人'}」）`
                        : '已连接（设置页凭证）'
                      : '未配置飞书应用凭证'
                }
              />
            </PillRow>
            <div className="st-hint">
              {larkStatus?.configured
                ? 'AI 可以直接读你发来的多维表格 / 云文档链接（只读，不改动飞书里的数据）。'
                : 'App ID / Secret 留空则自动复用 IM 渠道里的飞书机器人账号。'}
            </div>
            <div className="sf-actions-split">
              <button
                type="button"
                className="ui-btn"
                disabled={larkTesting}
                onClick={() => void testLark()}
              >
                {larkTesting ? '测试中…' : '测试读取'}
              </button>
              {larkStatus?.configured && !larkReconfig && (
                <button
                  type="button"
                  className="ui-btn is-end"
                  onClick={() => setLarkReconfig(true)}
                  title="换一个飞书自建应用，或改成复用 IM 渠道账号"
                >
                  重新配置凭证
                </button>
              )}
            </div>
            {(!larkStatus?.configured || larkReconfig) && (
              <>
                <FieldRow label="App ID">
                  <input
                    className="st-input"
                    value={form['lark.appId'] ?? ''}
                    onChange={(e) => patch('lark.appId', e.target.value)}
                    onBlur={(e) => saveLarkField('lark.appId', e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') saveLarkField('lark.appId', e.currentTarget.value)
                    }}
                    placeholder="cli_…（留空则复用 IM 渠道的飞书账号）"
                  />
                </FieldRow>
                <FieldRow label="App Secret">
                  <input
                    className="st-input"
                    type="password"
                    value={form['lark.appSecret'] ?? ''}
                    onChange={(e) => patch('lark.appSecret', e.target.value)}
                    onBlur={(e) => saveLarkField('lark.appSecret', e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') saveLarkField('lark.appSecret', e.currentTarget.value)
                    }}
                    placeholder="应用密钥（本地加密存储）"
                  />
                </FieldRow>
                <FieldRow label="默认链接">
                  <input
                    className="st-input"
                    value={form['lark.defaultUrl'] ?? ''}
                    onChange={(e) => patch('lark.defaultUrl', e.target.value)}
                    onBlur={(e) => saveLarkField('lark.defaultUrl', e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') saveLarkField('lark.defaultUrl', e.currentTarget.value)
                    }}
                    placeholder="https://xxx.feishu.cn/base/xxxxx（默认链接，可留空）"
                  />
                </FieldRow>
                <div className="sf-actions-split">
                  <span className="st-hint">填完点「完成」即可，改动已随失焦保存</span>
                  <button
                    type="button"
                    className="ui-btn is-primary"
                    onClick={() => {
                      setLarkReload((n) => n + 1)
                      setLarkReconfig(false)
                    }}
                  >
                    完成
                  </button>
                  {larkReconfig && (
                    <button
                      type="button"
                      className="ui-btn is-end"
                      onClick={() => setLarkReconfig(false)}
                    >
                      取消
                    </button>
                  )}
                </div>
              </>
            )}
            {larkTestRes && (
              <div className="st-ai-test">
                <span className={larkTestRes.ok ? 'st-ok' : 'st-bad'}>
                  {(larkTestRes.ok ? '✓ ' : '✗ ') +
                    larkTestRes.text.slice(0, 400) +
                    (larkTestRes.text.length > 400 ? '…' : '')}
                </span>
              </div>
            )}
            {(!larkStatus?.configured || larkReconfig) && (
              <AdvancedBlock label="权限前提（读不到时先看这里）">
                <div className="st-hint">
                  开放平台「权限管理」开通多维表格只读(bitable:app:readonly)与云文档只读
                  (docx:document:readonly)并发布版本；再把应用加为目标文档的协作者（分享 →
                  添加协作者 → 选本应用），否则接口会返回 403 / 权限类错误码。
                </div>
              </AdvancedBlock>
            )}
          </SettingsCard>

          <LarkBaseSyncSection reloadKey={larkReload} />
        </div>
      )}

      {tab === 'send' && (
        <div className="st-tab-panel">
          <div className="st-grid">
            {/* 发送频控 */}
            <SettingsCard title="发送与频控">
              <FieldRow label="每日发送上限">
                <input
                  className="st-input sm"
                  type="number"
                  min={1}
                  max={2000}
                  value={form['send.dailyLimit']}
                  onChange={(e) => patch('send.dailyLimit', e.target.value)}
                  onBlur={(e) => saveField('send.dailyLimit', e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') saveField('send.dailyLimit', e.currentTarget.value)
                  }}
                />
              </FieldRow>
              <FieldRow label="同会话连发窗口(秒)">
                <input
                  className="st-input sm"
                  type="number"
                  min={0}
                  max={3600}
                  value={form['send.sessionBurstWindowSec']}
                  onChange={(e) => patch('send.sessionBurstWindowSec', e.target.value)}
                  onBlur={(e) => saveField('send.sessionBurstWindowSec', e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter')
                      saveField('send.sessionBurstWindowSec', e.currentTarget.value)
                  }}
                />
                <div className="st-hint">
                  同一会话在这个窗口内最多连发 3 条,超出即拦截。机器连发是风控特征,而正常客服
                  (客户追问 / 补一条)不会被挡;0 = 关闭该限制。
                </div>
              </FieldRow>
              <FieldRow label="重复内容上限(会话数 / 24 小时)">
                <input
                  className="st-input sm"
                  type="number"
                  min={0}
                  max={500}
                  value={form['send.dupMaxSessions']}
                  onChange={(e) => patch('send.dupMaxSessions', e.target.value)}
                  onBlur={(e) => saveField('send.dupMaxSessions', e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') saveField('send.dupMaxSessions', e.currentTarget.value)
                  }}
                />
                <div className="st-hint">
                  同一条文案在 24 小时内发往多少会话后开始拦截。同文案群发是微信风控的首要触发点； 0
                  = 不限制。
                </div>
              </FieldRow>
              <SwitchRow
                label="拟人化延迟(发送间隔随机化)"
                desc="在节流区间内随机延迟后再发出,降低批量发送的机械感。"
                checked={boolVal(form['send.humanizeDelay'])}
                onChange={(v) => setNow('send.humanizeDelay', boolStr(v))}
              />
              <SwitchRow
                label="启用注入发送"
                desc="关闭后所有发送请求会被拒绝(仅记录审计)。"
                checked={boolVal(form['inject.enabled'])}
                onChange={(v) => setNow('inject.enabled', boolStr(v))}
              />
              <SwitchRow
                label="智能体发送消息"
                desc="允许对话智能体(工作台/对话页/飞书)通过 send_message 代发微信消息;关闭后该工具直接返回未开启。"
                checked={agentSendEnabled}
                onChange={(v) => {
                  setAgentSendEnabled(v)
                  void configApi?.set('send.agentEnabled', v ? '1' : '0')
                  toast.success(v ? '已开启智能体发送' : '已关闭智能体发送')
                }}
              />
              <SwitchRow
                label="发送需逐次审批"
                desc="每次代发前人工确认(工作台审批条/飞书回复「确认」);关闭后确认通过即直接发送,仍受频控与审计。"
                checked={agentSendApprove}
                onChange={(v) => {
                  setAgentSendApprove(v)
                  void configApi?.set('send.approve', v ? '1' : '0')
                  toast.success(v ? '已开启逐次审批' : '已关闭逐次审批(代发不再询问)')
                }}
              />
            </SettingsCard>

            {/* 熔断状态 */}
            <SettingsCard
              title="发送通道状态"
              desc="连续 2 次发送校验失败会自动熔断,复位前请先排查原因。"
            >
              <div className="st-status">
                <div className="st-kv">
                  <span>熔断状态</span>
                  <span className={sendStatus?.halted ? 'st-bad' : 'st-ok'}>
                    {sendStatus ? (sendStatus.halted ? '已熔断' : '正常') : '—'}
                  </span>
                </div>
                <div className="st-kv">
                  <span>今日已发送</span>
                  <span>
                    {sendStatus ? `${sendStatus.todayCount} / ${sendStatus.dailyLimit}` : '—'}
                  </span>
                </div>
                <div className="st-kv">
                  <span>队列等待</span>
                  <span>{sendStatus?.queued ?? '—'}</span>
                </div>
              </div>
              <div className="st-actions">
                <button
                  type="button"
                  className="ui-btn is-danger is-solid"
                  disabled={!sendStatus?.halted}
                  onClick={() => void resetCircuit()}
                >
                  复位熔断
                </button>
              </div>
            </SettingsCard>
          </div>
        </div>
      )}

      {tab === 'other' && (
        <div className="st-tab-panel">
          {/* 通知与提醒：此前散在「通用」「问题监控口径」「IM 渠道」三处，
              "为什么没提醒"要翻三个 tab 才能拼出全貌，现收成一张卡。 */}
          <SettingsCard
            title="通知与提醒"
            desc="哪些事要提醒、从哪个通道提醒。触发阈值仍在下方「问题监控口径」里配;飞书推送需要先在「IM 渠道」接一个飞书机器人。"
          >
            <div className="st-subtitle">桌面通知(本机弹窗/提示音)</div>
            <SwitchRow
              label="新消息系统通知"
              desc="后台消息到达时弹出系统通知(窗口未聚焦时)。"
              checked={boolVal(form['notify.enabled'])}
              onChange={(v) => setNow('notify.enabled', boolStr(v))}
            />
            <IssueSoundRow />
            <SwitchRow
              label="盯办升级提醒"
              desc="未指派超时(紧急>1h/其余>4h)、已指派长期未闭环与跟进超时的问题,后台每分钟巡检、窗口未聚焦时桌面提醒;同一问题的重复提醒间隔递增(45min → 90min → 3h → 6h)。"
              checked={escalateIssue}
              onChange={(v) => {
                setEscalateIssue(v)
                void configApi?.set('issue.escalate.enabled', v ? '1' : '0')
                toast.success(
                  v ? '已开启:未指派超时/跟进超时自动提醒' : '已关闭盯办提醒(监控页仍可见)'
                )
              }}
            />
            <div className="st-subtitle">飞书推送(推到群/同事单聊)</div>
            <FeishuNotifySection />
          </SettingsCard>

          <div className="st-grid">
            {/* 外观：第一张卡，因为它是"看一眼就想改"的那类设置 */}
            <SettingsCard
              title="外观"
              desc="深色适合夜间值班盯屏；跟随系统时以 Windows 的浅色/深色设置为准。切换立即生效，只影响本机显示。"
            >
              <div className={'st-row'}>
                <span className={'st-label'}>主题</span>
                <div className={'ui-seg'}>
                  {(
                    [
                      ['light', '浅色'],
                      ['dark', '深色'],
                      ['system', '跟随系统']
                    ] as Array<[ThemeMode, string]>
                  ).map(([value, label]) => (
                    <button
                      key={value}
                      type={'button'}
                      className={'ui-seg-btn' + (themeMode === value ? ' is-on' : '')}
                      onClick={() => {
                        setThemeMode(value)
                        setThemeModeState(value)
                      }}
                    >
                      {label}
                    </button>
                  ))}
                </div>
              </div>
            </SettingsCard>

            {/* 数据缓存目录 */}
            <SettingsCard
              title="数据与缓存"
              desc="用于解密图片/附件缓存与导出文件。默认优先取非系统盘(无可用盘符时回退应用数据目录);本地数据库 cs.db 固定存于应用数据目录,不随此项迁移。"
            >
              <div
                className="st-cache-pick"
                role="button"
                tabIndex={0}
                title="点击选择新的缓存目录"
                onClick={() => void browseCachePath()}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault()
                    void browseCachePath()
                  }
                }}
              >
                <div className="st-cache-main">
                  <span
                    className={`st-cache-tag${cacheEffective?.isDefault === false ? ' custom' : ''}`}
                  >
                    {cacheEffective?.isDefault === false ? '自定义目录' : '默认目录'}
                  </span>
                  <span className="st-cache-dir">
                    {cacheEffective ? cacheEffective.path : '加载中…'}
                  </span>
                </div>
                <span className="st-cache-change">选择…</span>
              </div>
              <div className="st-actions">
                {cacheEffective?.isDefault === false && (
                  <button type="button" className="ui-btn" onClick={() => void resetCachePath()}>
                    恢复默认
                  </button>
                )}
                <span className="st-hint">
                  选择目录后立即生效；切换目录后仅新缓存/导出写入新位置，旧目录内容需手动迁移
                </span>
              </div>
            </SettingsCard>

            {/* 启动行为（系统通知 / 提示音已移到「通知与提醒」） */}
            <SettingsCard title="启动" desc="应用自身的启动与驻留行为。">
              <SwitchRow
                label="开机自动启动"
                desc="打包安装后生效(开发模式下指向 Electron 本体);关闭窗口会最小化到系统托盘,可在托盘菜单中退出。"
                checked={autoLaunch}
                onChange={(v) => void toggleAutoLaunch(v)}
              />
            </SettingsCard>

            {/* 问题监控口径 */}
            <SettingsCard
              title="问题监控口径"
              desc="应用于监控中心 KPI、群问题面板的逾期徽标与排序提示;数值失焦或回车保存,立即生效。这些阈值也决定「通知与提醒」里盯办提醒的触发时机。"
            >
              <SwitchRow
                label="后台自动增量分析"
                desc="覆盖全部活跃群的新消息自动提取(不限于当前打开的群),无新消息时不消耗模型;还没分析过的新群每分钟补扫一个,直到全部建好水位。"
                checked={autoScanIssue}
                onChange={(v) => {
                  setAutoScanIssue(v)
                  void configApi?.set('issue.autoScan.enabled', v ? '1' : '0')
                  toast.success(
                    v ? '已开启:新消息事件 + 60s 巡检自动提取' : '已关闭后台自动分析(仍可手动分析)'
                  )
                }}
              />
              <SwitchRow
                label="自动合并重复议题"
                desc="后台每 10 分钟巡检:只有高置信重复(证据几乎完全重合 / 标题逐字一致)才自动合并为一条并归档其余;仅「同客户同类型+时间邻近」这类弱信号不自动处理,仍在监控页「合并重复」里预览确认。"
                checked={autoMergeIssue}
                onChange={(v) => {
                  setAutoMergeIssue(v)
                  void configApi?.set('issue.autoMergeDuplicates', v ? '1' : '0')
                  toast.success(v ? '已开启自动合并重复议题' : '已关闭自动合并(仍可手动合并)')
                }}
              />
              <FieldRow label="积压超时阈值" hint="小时:问题首现超过该时长未闭环即标为「积压超时」">
                <input
                  type="number"
                  min={1}
                  max={720}
                  className="st-input st-th-input"
                  value={backlogHours}
                  onChange={(e) => setBacklogHours(Number(e.target.value))}
                  onBlur={() =>
                    saveThreshold('monitor.backlogHours', backlogHours, 48, setBacklogHours)
                  }
                  onKeyDown={(e) => {
                    if (e.key === 'Enter')
                      saveThreshold('monitor.backlogHours', backlogHours, 48, setBacklogHours)
                  }}
                />
              </FieldRow>
              <FieldRow
                label="跟进超时阈值"
                hint="小时:客服回复后超过该时长仍未闭环即标为「跟进超时」"
              >
                <input
                  type="number"
                  min={1}
                  max={720}
                  className="st-input st-th-input"
                  value={followUpHours}
                  onChange={(e) => setFollowUpHours(Number(e.target.value))}
                  onBlur={() =>
                    saveThreshold('monitor.followUpHours', followUpHours, 12, setFollowUpHours)
                  }
                  onKeyDown={(e) => {
                    if (e.key === 'Enter')
                      saveThreshold('monitor.followUpHours', followUpHours, 12, setFollowUpHours)
                  }}
                />
              </FieldRow>
              <FieldRow
                label="静默收尾阈值"
                hint="小时:客服已回复、客户超过该时长再无消息 → 自动闭环(标记「自动解决」,可重新打开复核);0 = 关闭"
              >
                <input
                  type="number"
                  min={0}
                  max={720}
                  className="st-input st-th-input"
                  value={autoCloseHours}
                  onChange={(e) => setAutoCloseHours(Number(e.target.value))}
                  onBlur={() =>
                    saveThreshold('monitor.autoCloseHours', autoCloseHours, 72, setAutoCloseHours)
                  }
                  onKeyDown={(e) => {
                    if (e.key === 'Enter')
                      saveThreshold('monitor.autoCloseHours', autoCloseHours, 72, setAutoCloseHours)
                  }}
                />
              </FieldRow>
              <FieldRow
                label="已指派未闭环阈值"
                hint="小时:问题已指派跟进人但超过该时长仍未闭环,同样计入盯办升级"
              >
                <input
                  type="number"
                  min={1}
                  max={720}
                  className="st-input st-th-input"
                  value={escalateAssignedHours}
                  onChange={(e) => setEscalateAssignedHours(Number(e.target.value))}
                  onBlur={() =>
                    saveThreshold(
                      'issue.escalateAssignedHours',
                      escalateAssignedHours,
                      8,
                      setEscalateAssignedHours
                    )
                  }
                  onKeyDown={(e) => {
                    if (e.key === 'Enter')
                      saveThreshold(
                        'issue.escalateAssignedHours',
                        escalateAssignedHours,
                        8,
                        setEscalateAssignedHours
                      )
                  }}
                />
              </FieldRow>
            </SettingsCard>

            {/* 数据管理 */}
            <SettingsCard title="数据管理">
              <div className="st-kv">
                <span>本地数据库</span>
                <span>{dataStats ? formatBytes(dataStats.dbBytes) : '—'}</span>
              </div>
              <div className="st-kv">
                <span>缓存占用</span>
                <span>{dataStats ? formatBytes(dataStats.cacheBytes) : '—'}</span>
              </div>
              <div className="st-actions">
                <button
                  type="button"
                  className={`ui-btn${clearArmed ? ' is-danger is-solid' : ''}`}
                  onClick={() => void clearCache()}
                >
                  {clearArmed ? '再点一次确认清理' : '清理缓存'}
                </button>
                <span className="st-hint">仅清空缓存目录，不影响密钥、配置与审计数据</span>
              </div>
              <div className="st-version">
                {APP_NAME} v{version || '—'}
              </div>
            </SettingsCard>
          </div>
        </div>
      )}
    </div>
  )
}

export default SettingsPage
