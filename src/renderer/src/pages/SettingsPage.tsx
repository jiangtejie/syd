import { useEffect, useState } from 'react'
import type { SendStatusInfo } from '../../../shared/types'
import WechatKeySection from '../components/settings/WechatKeySection'
import { toast } from '../stores/toast'
import './settings.css'

/**
 * 设置页：微信数据与密钥 / AI 通道 / 发送频控 / 注入开关 / 熔断复位。
 * 配置真实读写主进程 app_config（cs:config），保存即生效。
 */

interface FormState {
  'ai.enabled': string
  'ai.baseUrl': string
  'ai.apiKey': string
  'ai.model': string
  'send.dailyLimit': string
  'send.humanizeDelay': string
  'inject.enabled': string
  'cache.path': string
  'notify.enabled': string
}

const DEFAULTS: FormState = {
  'ai.enabled': '0',
  'ai.baseUrl': 'https://api.openai.com/v1',
  'ai.apiKey': '',
  'ai.model': 'gpt-4o-mini',
  'send.dailyLimit': '200',
  'send.humanizeDelay': '1',
  'inject.enabled': '1',
  'cache.path': '',
  'notify.enabled': '1'
}

const configApi = window.api?.cs?.config
const replyApi = window.api?.cs?.reply
const appApi = window.api?.cs?.app

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`
}

function SettingsPage(): React.JSX.Element {
  const [form, setForm] = useState<FormState>(DEFAULTS)
  const [loaded, setLoaded] = useState(false)
  const [savedTip, setSavedTip] = useState('')
  const [sendStatus, setSendStatus] = useState<SendStatusInfo | null>(null)
  const [cacheEffective, setCacheEffective] = useState<{ path: string; defaultPath: string } | null>(null)
  const [autoLaunch, setAutoLaunch] = useState(false)
  const [dataStats, setDataStats] = useState<{ dbBytes: number; cacheBytes: number } | null>(null)
  const [clearArmed, setClearArmed] = useState(false)
  const [version, setVersion] = useState('')

  useEffect(() => {
    void configApi?.getAll().then((cfg) => {
      setForm((prev) => {
        const next = { ...prev }
        for (const k of Object.keys(next) as Array<keyof FormState>) {
          if (cfg[k] !== undefined && cfg[k] !== '') next[k] = cfg[k]
        }
        return next
      })
      setLoaded(true)
    })
    void replyApi?.getSendStatus().then(setSendStatus).catch(() => undefined)
    void configApi?.cachePath().then((r) => {
      if (r?.ok && r.path && r.defaultPath) {
        setCacheEffective({ path: r.path, defaultPath: r.defaultPath })
      }
    })
    void appApi?.getAutoLaunch().then((r) => setAutoLaunch(!!r?.enabled))
    void appApi?.info().then((r) => setVersion(r?.version ?? ''))
    void refreshDataStats()
  }, [])

  const refreshDataStats = async (): Promise<void> => {
    const r = await appApi?.dataStats().catch(() => null)
    if (r?.ok && r.dbBytes !== undefined && r.cacheBytes !== undefined) {
      setDataStats({ dbBytes: r.dbBytes, cacheBytes: r.cacheBytes })
    }
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

  const browseCachePath = async (): Promise<void> => {
    const r = await window.api?.cs?.dialog?.pickDirectory('选择数据缓存目录')
    if (r?.ok && r.path) patch('cache.path', r.path)
  }

  const saveCachePath = async (): Promise<void> => {
    await configApi?.set('cache.path', form['cache.path'].trim())
    const r = await configApi?.cachePath().catch(() => null)
    if (r?.ok && r.path && r.defaultPath) {
      setCacheEffective({ path: r.path, defaultPath: r.defaultPath })
    }
    setSavedTip('已保存')
    setTimeout(() => setSavedTip(''), 2000)
  }

  const boolVal = (v: string): boolean => v === '1' || v === 'true'
  const boolStr = (b: boolean): string => (b ? '1' : '0')

  return (
    <div className="page-scroll">
      <h2 className="page-title">设置</h2>
      <div className="page-subtitle">
        配置保存后立即生效 {savedTip && <span className="st-saved">{savedTip}</span>}
        {!loaded && '（加载中…）'}
      </div>

      {/* 微信数据与密钥（解密配置，参考 CipherTalk DatabaseTab） */}
      <WechatKeySection />

      {/* 其余配置两列紧凑排列 */}
      <div className="st-grid">
        {/* AI 通道 */}
        <div className="page-card st-section">
          <div className="st-title">AI 建议通道</div>
        <label className="st-row">
          <span className="st-label">启用 LLM 生成</span>
          <input
            type="checkbox"
            checked={boolVal(form['ai.enabled'])}
            onChange={(e) => patch('ai.enabled', boolStr(e.target.checked))}
          />
        </label>
        <label className="st-row">
          <span className="st-label">接口地址（OpenAI 兼容）</span>
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
          <span className="st-label">模型</span>
          <input
            className="st-input"
            value={form['ai.model']}
            onChange={(e) => patch('ai.model', e.target.value)}
          />
        </label>
        <div className="st-actions">
          <button
            type="button"
            className="st-btn"
            onClick={() => void save(['ai.enabled', 'ai.baseUrl', 'ai.apiKey', 'ai.model'])}
          >
            保存 AI 配置
          </button>
          <span className="st-hint">未启用或未配置 Key 时，建议条自动降级为知识库模板话术</span>
        </div>
      </div>

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

      {/* 数据缓存目录 */}
      <div className="page-card st-section">
        <div className="st-title">数据与缓存</div>
        <label className="st-row">
          <span className="st-label">缓存目录</span>
          <input
            className="st-input"
            value={form['cache.path']}
            onChange={(e) => patch('cache.path', e.target.value)}
            placeholder={cacheEffective ? `默认：${cacheEffective.defaultPath}` : '默认：应用数据目录/cache'}
          />
          <button type="button" className="st-btn ghost" onClick={() => void browseCachePath()}>
            浏览…
          </button>
        </label>
        <div className="st-actions">
          <button type="button" className="st-btn" onClick={() => void saveCachePath()}>
            保存缓存配置
          </button>
          <button
            type="button"
            className="st-btn ghost"
            onClick={() => {
              patch('cache.path', '')
              void configApi?.set('cache.path', '').then(() => {
                void configApi?.cachePath().then((r) => {
                  if (r?.ok && r.path && r.defaultPath) {
                    setCacheEffective({ path: r.path, defaultPath: r.defaultPath })
                  }
                })
              })
            }}
          >
            恢复默认
          </button>
        </div>
        {cacheEffective && (
          <div className="st-kv st-cache-effective">
            <span>当前生效</span>
            <span className="st-path">{cacheEffective.path}</span>
          </div>
        )}
        <div className="st-hint st-cache-hint">
          用于解密图片/附件缓存、导出文件等（媒体解密与导出接入后写入）；
          默认目录优先取非系统盘（无可用盘符时回退应用数据目录）；
          本地数据库（cs.db）固定存于应用数据目录，不随此项迁移。留空即使用默认目录。
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
  )
}

export default SettingsPage
