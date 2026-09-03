import { useEffect, useState } from 'react'
import type { SendStatusInfo } from '../../../shared/types'
import WechatKeySection from '../components/settings/WechatKeySection'
import AgentSettingsSection from '../components/settings/AgentSettingsSection'
import { toast } from '../stores/toast'
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
  'send.dailyLimit': string
  'send.humanizeDelay': string
  'inject.enabled': string
  'notify.enabled': string
}

/** AI 通道预设（OpenAI 兼容 chat/completions），选择后自动填充地址与示例模型，仍可手动修改 */
interface AiPreset {
  id: string
  label: string
  baseUrl: string
  model: string
  models: string[]
}

const AI_PRESETS: AiPreset[] = [
  {
    id: 'openai',
    label: 'OpenAI',
    baseUrl: 'https://api.openai.com/v1',
    model: 'gpt-4o-mini',
    models: ['gpt-4o-mini', 'gpt-4o', 'gpt-4.1-mini', 'gpt-4.1']
  },
  {
    id: 'deepseek',
    label: 'DeepSeek（深度求索）',
    baseUrl: 'https://api.deepseek.com/v1',
    model: 'deepseek-chat',
    models: ['deepseek-chat', 'deepseek-reasoner']
  },
  {
    id: 'dashscope',
    label: '阿里云百炼（通义千问）',
    baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    model: 'qwen-plus',
    models: ['qwen-plus', 'qwen-turbo', 'qwen-max', 'qwen-long']
  },
  {
    id: 'zhipu',
    label: '智谱 AI（GLM）',
    baseUrl: 'https://open.bigmodel.cn/api/paas/v4',
    model: 'glm-4-flash',
    models: ['glm-4-flash', 'glm-4-air', 'glm-4-plus', 'glm-4-long']
  },
  {
    id: 'moonshot',
    label: 'Moonshot（Kimi）',
    baseUrl: 'https://api.moonshot.cn/v1',
    model: 'kimi-latest',
    models: ['kimi-latest', 'moonshot-v1-8k', 'moonshot-v1-32k', 'moonshot-v1-128k']
  },
  {
    id: 'siliconflow',
    label: '硅基流动 SiliconFlow',
    baseUrl: 'https://api.siliconflow.cn/v1',
    model: 'Qwen/Qwen2.5-7B-Instruct',
    models: ['Qwen/Qwen2.5-7B-Instruct', 'deepseek-ai/DeepSeek-V3', 'THUDM/glm-4-9b-chat']
  },
  {
    id: 'volcengine',
    label: '火山方舟（豆包）',
    baseUrl: 'https://ark.cn-beijing.volces.com/api/v3',
    model: 'ep-xxxxxxxx（推理接入点 ID）',
    models: ['doubao-pro-32k', 'doubao-lite-32k']
  },
  {
    id: 'ollama',
    label: 'Ollama（本地）',
    baseUrl: 'http://localhost:11434/v1',
    model: 'qwen2.5',
    models: ['qwen2.5', 'llama3.1', 'deepseek-r1']
  },
  {
    id: 'custom',
    label: '自定义（OpenAI 兼容）',
    baseUrl: '',
    model: '',
    models: []
  }
]

const DEFAULTS: FormState = {
  'ai.enabled': '0',
  'ai.provider': 'openai',
  'ai.baseUrl': 'https://api.openai.com/v1',
  'ai.apiKey': '',
  'ai.model': 'gpt-4o-mini',
  'send.dailyLimit': '200',
  'send.humanizeDelay': '1',
  'inject.enabled': '1',
  'notify.enabled': '1'
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

/** 设置页 Tab 板块 */
type SettingsTab = 'wechat' | 'ai' | 'send' | 'other'

const SETTINGS_TAB_KEYS: readonly SettingsTab[] = ['wechat', 'ai', 'send', 'other']
/** 记住上次所选 Tab（localStorage，首次进入默认「微信数据」） */
const SETTINGS_TAB_KEY = 'cs.settingsTab'

function SettingsPage(): React.JSX.Element {
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
  const [aiTestRes, setAiTestRes] = useState<{ ok: boolean; latencyMs?: number; error?: string } | null>(
    null
  )
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
      setLoaded(true)
    })
    void replyApi?.getSendStatus().then(setSendStatus).catch(() => undefined)
    // eslint-disable-next-line react-hooks/set-state-in-effect -- 挂载时一次性刷新缓存目录展示（异步回调后 setState）
    void refreshCachePath()
    void appApi?.getAutoLaunch().then((r) => setAutoLaunch(!!r?.enabled))
    void appApi?.info().then((r) => setVersion(r?.version ?? ''))
    // eslint-disable-next-line react-hooks/set-state-in-effect -- 挂载时一次性刷新数据占用统计（异步回调后 setState）
    void refreshDataStats()
  }, [])

  /** 路径是否相同（忽略末尾分隔符与大小写，Windows 路径不区分大小写） */
  const samePath = (a: string, b: string): boolean =>
    a.replace(/\\+$/, '').toLowerCase() === b.replace(/\\+$/, '').toLowerCase()

  /** 应用缓存目录配置并刷新状态：对话框选完/恢复默认后即保存生效 */
  const applyCachePath = async (dir: string): Promise<void> => {
    const dir2 = dir.trim()
    // 恰好选回默认目录时归一化为空配置，保持「默认目录」展示
    const final =
      dir2 && cacheEffective && samePath(dir2, cacheEffective.defaultPath) ? '' : dir2
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

  /** 切换设置 Tab 并记忆选择（下次进入直接定位） */
  const switchTab = (key: SettingsTab): void => {
    setTab(key)
    try {
      localStorage.setItem(SETTINGS_TAB_KEY, key)
    } catch {
      /* localStorage 不可用（隐私模式等）时仅本次生效 */
    }
  }

  const save = async (keys: Array<keyof FormState>): Promise<void> => {
    if (!configApi) return
    for (const k of keys) {
      await configApi.set(k, form[k])
    }
    setSavedTip('已保存')
    setTimeout(() => setSavedTip(''), 2000)
  }

  const resetCircuit = async (): Promise<void> => {
    await replyApi?.resetCircuit()
    const s = await replyApi?.getSendStatus().catch(() => null)
    setSendStatus(s ?? null)
  }

  /** 选择通道预设：除「自定义」外自动填充地址与示例模型（之后仍可手动改） */
  const pickAiProvider = (id: string): void => {
    patch('ai.provider', id)
    // 通道切换后清空上次拉取的模型列表，避免混入上一通道的模型
    setAiModels([])
    setAiModelsMsg(null)
    // 自定义通道无预置模型 → 直接进入自由输入；其它通道用下拉选择
    setModelFree(id === 'custom')
    if (id !== 'custom') {
      const preset = AI_PRESETS.find((p) => p.id === id)
      if (preset) {
        patch('ai.baseUrl', preset.baseUrl)
        patch('ai.model', preset.model)
      }
    }
  }

  /** 用当前表单值（无需先保存）拉取该通道可用模型，自动选中第一个并列入下拉 */
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
        patch('ai.model', r.models[0]) // 默认模型 = 获取到的第一个
        setAiModelsMsg({ ok: true, text: `已获取 ${r.models.length} 个模型，默认选中第一个，可下拉切换` })
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

  // 模型下拉候选：当前通道预置模型 ∪ 远程获取模型 ∪ 当前已填值（保证已选项可见）
  const modelCandidates = Array.from(
    new Set(
      [
        ...(AI_PRESETS.find((p) => p.id === form['ai.provider'])?.models ?? []),
        ...aiModels,
        form['ai.model']
      ].filter((m) => typeof m === 'string' && m.trim() !== '')
    )
  ) as string[]

  return (
    <div className="page-scroll">
      <h2 className="page-title">设置</h2>
      <div className="page-subtitle">
        配置保存后立即生效 {savedTip && <span className="st-saved">{savedTip}</span>}
        {!loaded && '（加载中…）'}
      </div>

      {/* Tab 导航（按板块切换，减少拥挤） */}
      <div className="st-tabs" role="tablist" aria-label="设置板块">
        {(
          [
            ['wechat', '微信数据'],
            ['ai', 'AI 助手'],
            ['send', '发送与频控'],
            ['other', '偏好与数据']
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

      {tab === 'wechat' && (
        <div className="st-tab-panel">
          <WechatKeySection />
        </div>
      )}

      {tab === 'ai' && (
        <div className="st-tab-panel">
        {/* AI 通道（独占一行） */}
      <div className="page-card st-section">
        <div className="st-title">AI 通道配置（OpenAI 兼容）</div>
        <label className="st-row">
          <span className="st-label">启用 AI 调用</span>
          <input
            type="checkbox"
            checked={boolVal(form['ai.enabled'])}
            onChange={(e) => patch('ai.enabled', boolStr(e.target.checked))}
          />
        </label>
        <label className="st-row">
          <span className="st-label">通道</span>
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
        </label>
        <label className="st-row">
          <span className="st-label">接口地址（Base URL）</span>
          <input
            className="st-input"
            value={form['ai.baseUrl']}
            onChange={(e) => patch('ai.baseUrl', e.target.value)}
            placeholder="https://api.openai.com/v1"
          />
        </label>
        <label className="st-row">
          <span className="st-label">API Key</span>
          <input
            className="st-input"
            type="password"
            value={form['ai.apiKey']}
            onChange={(e) => patch('ai.apiKey', e.target.value)}
            placeholder="sk-..."
          />
        </label>
        <label className="st-row">
          <span className="st-label">模型名称</span>
          <span className="st-mrow">
            {modelFree ? (
              <input
                className="st-input"
                value={form['ai.model']}
                onChange={(e) => patch('ai.model', e.target.value)}
                placeholder={form['ai.provider'] === 'custom' ? '输入任意 OpenAI 兼容模型名' : '模型名'}
              />
            ) : (
              <select
                className="st-input"
                value={modelCandidates.includes(form['ai.model']) ? form['ai.model'] : ''}
                onChange={(e) => {
                  if (e.target.value === '__manual__') {
                    setModelFree(true)
                  } else {
                    patch('ai.model', e.target.value)
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
                className="st-btn ghost"
                onClick={() => setModelFree(false)}
                title="从下拉列表选择模型"
              >
                列表选择
              </button>
            )}
            <button
              type="button"
              className="st-btn ghost"
              disabled={aiModelsLoading || !form['ai.baseUrl'].trim()}
              onClick={() => void fetchAiModels()}
              title="调用 {Base URL}/models 拉取当前通道可用模型"
            >
              {aiModelsLoading ? '获取中…' : '获取模型'}
            </button>
          </span>
        </label>
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
            className="st-btn ghost"
            disabled={aiTesting}
            onClick={() => void testAi()}
          >
            {aiTesting ? '测试中…' : '测试连接'}
          </button>
          <button
            type="button"
            className="st-btn"
            onClick={() =>
              void save([
                'ai.enabled',
                'ai.provider',
                'ai.baseUrl',
                'ai.apiKey',
                'ai.model'
              ])
            }
          >
            保存 AI 配置
          </button>
        </div>
        <div className="st-ai-test">
          {aiTestRes &&
            (aiTestRes.ok ? (
              <span className="st-ok">✓ 连接成功 · {aiTestRes.latencyMs} ms</span>
            ) : (
              <span className="st-bad">✗ {aiTestRes.error}</span>
            ))}
        </div>
        <span className="st-hint">
          选择通道会自动填充官方地址与常用模型（火山方舟需在控制台创建推理接入点后填入
          ep-xxx），地址与模型可手动修改。建议先「测试连接」通过后再保存；未启用或未配置 Key
          时自动降级：回复建议回退模板话术、问题反馈走本地规则提取。
        </span>
      </div>

      {/* 智能体（客服人设） */}
      <div className="page-card st-section">
        <div className="st-title">智能体（客服人设）</div>
        <span className="st-hint">
          一个智能体 = 名称 + 人设 + 话术风格 + 自定义守则，用于 AI 生成回复建议时扮演的角色。
          内置默认「微信私域智能客服」，可随时新建/切换。
        </span>
          <AgentSettingsSection />
        </div>
        </div>
      )}

      {tab === 'send' && (
        <div className="st-tab-panel">
          <div className="st-grid">
      {/* 发送频控 */}
      <div className="page-card st-section">
        <div className="st-title">发送与频控</div>
        <label className="st-row">
          <span className="st-label">每日发送上限</span>
          <input
            className="st-input sm"
            type="number"
            min={1}
            max={2000}
            value={form['send.dailyLimit']}
            onChange={(e) => patch('send.dailyLimit', e.target.value)}
          />
        </label>
        <label className="st-row">
          <span className="st-label">拟人化延迟（发送间隔随机化）</span>
          <input
            type="checkbox"
            checked={boolVal(form['send.humanizeDelay'])}
            onChange={(e) => patch('send.humanizeDelay', boolStr(e.target.checked))}
          />
        </label>
        <label className="st-row">
          <span className="st-label">启用注入发送</span>
          <input
            type="checkbox"
            checked={boolVal(form['inject.enabled'])}
            onChange={(e) => patch('inject.enabled', boolStr(e.target.checked))}
          />
        </label>
        <div className="st-actions">
          <button
            type="button"
            className="st-btn"
            onClick={() => void save(['send.dailyLimit', 'send.humanizeDelay', 'inject.enabled'])}
          >
            保存发送配置
          </button>
          <span className="st-hint">关闭注入后所有发送请求会被拒绝（仅记录审计）</span>
        </div>
      </div>

      {/* 熔断状态 */}
      <div className="page-card st-section">
        <div className="st-title">发送通道状态</div>
        <div className="st-status">
          <div className="st-kv">
            <span>熔断状态</span>
            <span className={sendStatus?.halted ? 'st-bad' : 'st-ok'}>
              {sendStatus ? (sendStatus.halted ? '已熔断' : '正常') : '—'}
            </span>
          </div>
          <div className="st-kv">
            <span>今日已发送</span>
            <span>{sendStatus ? `${sendStatus.todayCount} / ${sendStatus.dailyLimit}` : '—'}</span>
          </div>
          <div className="st-kv">
            <span>队列等待</span>
            <span>{sendStatus?.queued ?? '—'}</span>
          </div>
        </div>
        <div className="st-actions">
          <button
            type="button"
            className="st-btn danger"
            disabled={!sendStatus?.halted}
            onClick={() => void resetCircuit()}
          >
            复位熔断
          </button>
          <span className="st-hint">连续 2 次发送校验失败会自动熔断，复位前请先排查原因</span>
        </div>
      </div>
        </div>
      </div>
      )}

      {tab === 'other' && (
        <div className="st-tab-panel">
          <div className="st-grid">
      {/* 数据缓存目录 */}
      <div className="page-card st-section">
        <div className="st-title">数据与缓存</div>
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
            <span className={`st-cache-tag${cacheEffective?.isDefault === false ? ' custom' : ''}`}>
              {cacheEffective?.isDefault === false ? '自定义目录' : '默认目录'}
            </span>
            <span className="st-cache-dir">{cacheEffective ? cacheEffective.path : '加载中…'}</span>
          </div>
          <span className="st-cache-change">选择…</span>
        </div>
        <div className="st-actions">
          {cacheEffective?.isDefault === false && (
            <button type="button" className="st-btn ghost" onClick={() => void resetCachePath()}>
              恢复默认
            </button>
          )}
          <span className="st-hint">
            选择目录后立即生效；切换目录后仅新缓存/导出写入新位置，旧目录内容需手动迁移
          </span>
        </div>
        <div className="st-hint st-cache-hint">
          用于解密图片/附件缓存与导出文件。默认优先取非系统盘（无可用盘符时回退应用数据目录）；
          本地数据库 cs.db 固定存于应用数据目录，不随此项迁移。
        </div>
      </div>

      {/* 通用（通知 / 开机自启） */}
      <div className="page-card st-section">
        <div className="st-title">通用</div>
        <label className="st-row">
          <span className="st-label">新消息系统通知</span>
          <input
            type="checkbox"
            checked={boolVal(form['notify.enabled'])}
            onChange={(e) => {
              patch('notify.enabled', boolStr(e.target.checked))
              void configApi?.set('notify.enabled', boolStr(e.target.checked))
            }}
          />
        </label>
        <label className="st-row">
          <span className="st-label">开机自动启动</span>
          <input
            type="checkbox"
            checked={autoLaunch}
            onChange={(e) => void toggleAutoLaunch(e.target.checked)}
          />
        </label>
        <div className="st-hint st-cache-hint">
          关闭窗口会最小化到系统托盘，可在托盘菜单中退出；
          开机自启在打包安装后生效（开发模式下指向 Electron 本体）。
        </div>
      </div>

      {/* 数据管理 */}
      <div className="page-card st-section">
        <div className="st-title">数据管理</div>
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
            className={`st-btn${clearArmed ? ' danger' : ' ghost'}`}
            onClick={() => void clearCache()}
          >
            {clearArmed ? '再点一次确认清理' : '清理缓存'}
          </button>
          <span className="st-hint">仅清空缓存目录，不影响密钥、配置与审计数据</span>
        </div>
        <div className="st-version">微信私域智能客服 v{version || '—'}</div>
        </div>
        </div>
        </div>
      )}
    </div>
  )
}

export default SettingsPage
