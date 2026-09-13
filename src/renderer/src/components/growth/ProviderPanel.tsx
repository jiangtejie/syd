import { useEffect, useState } from 'react'
import { toast } from '../../stores/toast'
import { growthApi, VENDOR_PRESETS } from './meta'
import { Switch, Badge } from './common'

export function ProviderPanel({ onChanged }: { onChanged: () => void }): React.JSX.Element {
  const [provider, setProvider] = useState('')
  const [apiKey, setApiKey] = useState('')
  const [autoEnabled, setAutoEnabled] = useState(false)
  const [showKey, setShowKey] = useState(false)
  const [loaded, setLoaded] = useState(false)
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    if (!growthApi) return
    let alive = true
    growthApi.configGet().then((res) => {
      if (!alive) return
      if (res.ok) {
        setProvider(res.provider ?? '')
        setApiKey(res.providerApiKey ?? '')
        setAutoEnabled(res.autoEnabled ?? false)
      }
      setLoaded(true)
    })
    return () => {
      alive = false
    }
  }, [])

  const save = async (): Promise<void> => {
    if (!growthApi) return
    if (!provider.trim()) {
      toast.error('请填写数据服务商标识')
      return
    }
    setSaving(true)
    try {
      const p1 = await growthApi.configSet('provider', provider)
      if (!p1.ok) {
        toast.error(p1.error || '保存失败')
        return
      }
      const p2 = await growthApi.configSet('providerApiKey', apiKey)
      if (!p2.ok) {
        toast.error(p2.error || '保存失败')
        return
      }
      const p3 = await growthApi.configSet('autoEnabled', autoEnabled ? '1' : '0')
      if (!p3.ok) toast.error(p3.error || '保存失败')
      else {
        toast.success('数据服务配置已保存')
        onChanged()
      }
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className={'page-card gth-card'}>
      <div className={'gth-card-head'}>
        <span className={'gth-card-title'}>第三方数据服务商</span>
        <span className={'gth-card-sub'}>
          <Badge tone={loaded ? (provider ? 'green' : 'gray') : 'gray'}>
            {loaded ? (provider ? '已配置' : '未配置') : '加载中…'}
          </Badge>
        </span>
      </div>
      <div className={'gth-form-grid'}>
        <div className={'gth-field'}>
          <span className={'gth-field-label'}>
            供应商标识<span className={'req'}>*</span>
          </span>
          <input
            className="ui-input gth-input"
            list={'gth-vendors'}
            value={provider}
            placeholder={'选择或输入, 如 chanmama / newhong'}
            onChange={(e) => setProvider(e.target.value)}
          />
          <datalist id={'gth-vendors'}>
            {VENDOR_PRESETS.map((v) => (
              <option key={v} value={v} />
            ))}
          </datalist>
          <span className={'gth-field-hint'}>
            适配器按此标识加载(Phase 1 提供); 常见: {VENDOR_PRESETS.slice(0, 3).join(' / ')} 等
          </span>
        </div>
        <div className={'gth-field'}>
          <span className={'gth-field-label'}>API Key</span>
          <span className={'gth-key-wrap'}>
            <input
              className={'ui-input gth-input'}
              type={showKey ? 'text' : 'password'}
              value={apiKey}
              placeholder={'数据服务订阅后获取'}
              onChange={(e) => setApiKey(e.target.value)}
            />
            <button className={'gth-key-eye'} type={'button'} onClick={() => setShowKey((v) => !v)}>
              {showKey ? '隐藏' : '显示'}
            </button>
          </span>
          <span className={'gth-field-hint'}>safeStorage 加密后落盘, 只在本机解密使用</span>
        </div>
        <div className={'gth-field'}>
          <span className={'gth-field-label'}>自动采集总开关</span>
          <div style={{ height: 30, display: 'flex', alignItems: 'center' }}>
            <Switch
              checked={autoEnabled}
              onChange={setAutoEnabled}
              label={autoEnabled ? '开启: 按订阅间隔自动拉取' : '关闭: 仅手动/链接入库'}
            />
          </div>
          <span className={'gth-field-hint'}>心跳 30s; 建议配置并测试成功后开启</span>
        </div>
        <div className={'gth-field'}>
          <span className={'gth-field-label'}>&nbsp;</span>
          <button
            className={'ui-btn is-primary gth-btn'}
            type={'button'}
            disabled={saving || !loaded}
            onClick={() => void save()}
          >
            {saving ? '保存中…' : '保存配置'}
          </button>
        </div>
      </div>
      <div className={'gth-card-note'}>
        Phase 0 说明: 当前为本地骨架期, 供应商适配器接入后此处保存的标识与 Key 将直接生效;
        在此之前可先用「素材仓库」页粘贴小红书/抖音分享链接或口令入库, 不受数据服务影响。
      </div>
    </div>
  )
}

// ── 采集源管理 ──
