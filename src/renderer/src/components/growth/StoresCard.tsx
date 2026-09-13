/**
 * 门店与品牌档案配置(营销 → 数据服务)。
 * 这是营销 AI 工作台的「事实白名单」: AI 只能使用这里配置的信息, 缺失会追问。
 */

import { useCallback, useEffect, useState } from 'react'
import { toast } from '../../stores/toast'
import { confirmAsk } from '../../stores/confirmDialog'
import { FieldRow, SettingsCard } from '../settings/ui'

interface StoreView {
  id: number
  brandName: string
  name: string
  city: string
  address: string
  bizType: string
  poi: string
  profile: string
  enabled: boolean
}

const PROFILE_KEYS: Array<{ key: string; label: string; placeholder: string }> = [
  { key: 'phone', label: '电话', placeholder: '028-xxxxxxx' },
  { key: 'hours', label: '营业时间', placeholder: '11:00-22:00(周一至周日)' },
  { key: 'avgPrice', label: '人均', placeholder: '80' },
  { key: 'signatureDishes', label: '招牌菜', placeholder: '百香果牛肉、鲜切黄牛肉…' },
  { key: 'packages', label: '套餐', placeholder: '双人餐 128(含…)；四人餐 238…' },
  { key: 'parking', label: '停车', placeholder: '商场 B2 免费 2 小时' },
  { key: 'privateRoom', label: '包间', placeholder: '4 个包间, 需提前预订' },
  { key: 'tone', label: '语气', placeholder: '亲切、成都本地口吻' },
  { key: 'bannedWords', label: '禁用词', placeholder: '最好吃、第一、养生…' }
]

const api = window.api?.cs?.growthai

function parseProfile(raw: string): Record<string, string> {
  try {
    const v = JSON.parse(raw || '{}') as Record<string, unknown>
    const out: Record<string, string> = {}
    for (const k of Object.keys(v))
      out[k] = typeof v[k] === 'string' ? (v[k] as string) : String(v[k] ?? '')
    return out
  } catch {
    return {}
  }
}

export default function StoresCard(): React.JSX.Element {
  const [stores, setStores] = useState<StoreView[]>([])
  const [brandName, setBrandName] = useState('')
  const [brandProfile, setBrandProfile] = useState('')
  const [editing, setEditing] = useState<StoreView | null>(null)
  const [form, setForm] = useState<Record<string, string>>({})
  const [busy, setBusy] = useState(false)
  const [open, setOpen] = useState(false)

  const load = useCallback(async (): Promise<void> => {
    if (!api) return
    const res = await api.listStores()
    if (res.ok) setStores((res.stores ?? []) as StoreView[])
    const b = await api.getBrand()
    if (b.ok && b.brand) {
      const br = b.brand as { name: string; profile: string }
      setBrandName(br.name ?? '')
      setBrandProfile(br.profile ?? '')
    }
  }, [])

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- 挂载时加载门店与品牌(全仓同款模式)
    void load()
  }, [load])

  const startNew = (): void => {
    setEditing(null)
    setForm({})
    setOpen(true)
  }

  const startEdit = (s: StoreView): void => {
    setEditing(s)
    const p = parseProfile(s.profile)
    const f: Record<string, string> = {
      brandName: s.brandName,
      name: s.name,
      city: s.city,
      address: s.address,
      bizType: s.bizType,
      poi: s.poi
    }
    for (const k of PROFILE_KEYS) f[k.key] = p[k.key] ?? ''
    setForm(f)
    setOpen(true)
  }

  const save = async (): Promise<void> => {
    if (!api) return
    if (!form.name?.trim()) {
      toast.error('门店名称不能为空')
      return
    }
    setBusy(true)
    try {
      const profile: Record<string, string> = {}
      for (const k of PROFILE_KEYS) {
        const v = (form[k.key] ?? '').trim()
        if (v) profile[k.key] = v
      }
      const res = await api.saveStore({
        id: editing?.id,
        brandName: (form.brandName ?? '').trim(),
        name: form.name.trim(),
        city: (form.city ?? '').trim(),
        address: (form.address ?? '').trim(),
        bizType: (form.bizType ?? '').trim(),
        poi: form.poi ?? '[]',
        profile: JSON.stringify(profile),
        enabled: true
      })
      if (!res.ok) {
        toast.error(res.error || '保存失败')
        return
      }
      toast.success(editing ? '门店已更新' : '门店已创建')
      setOpen(false)
      await load()
    } finally {
      setBusy(false)
    }
  }

  const remove = async (s: StoreView): Promise<void> => {
    if (!api) return
    const ok = await confirmAsk({
      title: '删除门店',
      message: '删除门店「' + s.name + '」的档案? 已生成的文案不受影响。',
      confirmText: '删除',
      danger: true
    })
    if (!ok) return
    await api.removeStore(s.id)
    toast.success('已删除')
    await load()
  }

  const saveBrand = async (): Promise<void> => {
    if (!api) return
    setBusy(true)
    try {
      await api.saveBrand(brandName, brandProfile || '{}')
      toast.success('品牌资料包已保存')
    } finally {
      setBusy(false)
    }
  }

  if (!api) return <div className="gth-error">门店配置不可用(请重启应用)</div>

  return (
    <>
      <SettingsCard
        title="品牌资料包"
        desc="品牌层面的统一口径: AI 生成文案时会遵循这里的定位与语气。JSON 或纯文本都可以。"
      >
        <FieldRow label="品牌名">
          <input
            className="st-input"
            value={brandName}
            onChange={(e) => setBrandName(e.target.value)}
            placeholder="如 萍姐火锅"
          />
        </FieldRow>
        <FieldRow label="资料包">
          <textarea
            className="st-input"
            rows={4}
            value={brandProfile}
            onChange={(e) => setBrandProfile(e.target.value)}
            placeholder='{"positioning":"社区鲜货火锅","tone":"成都本地、亲切","sellingPoints":["鲜切黄牛肉","百香果牛肉"]}'
          />
        </FieldRow>
        <FieldRow label="保存">
          <button
            className="ui-btn is-primary gth-btn"
            type="button"
            disabled={busy}
            onClick={() => void saveBrand()}
          >
            保存品牌资料包
          </button>
        </FieldRow>
      </SettingsCard>

      <SettingsCard
        title="门店档案"
        desc="AI 只能使用这里配置的事实; 缺失字段会主动追问或用占位符, 不会编造。地址/电话等敏感信息建议人工核对后再填。"
      >
        <div className="gth-btn-row" style={{ marginBottom: 10 }}>
          <button className="ui-btn is-primary gth-btn sm" type="button" onClick={startNew}>
            + 新增门店
          </button>
          <span className="gth-sub">共 {stores.length} 家</span>
        </div>

        {stores.length === 0 ? (
          <div className="gth-empty">还没有门店档案, 点「+ 新增门店」创建第一家</div>
        ) : (
          <div className="gth-list">
            {stores.map((s) => {
              const p = parseProfile(s.profile)
              return (
                <div className="gai-store-row" key={s.id}>
                  <div className="gth-main">
                    <div className="t">
                      <span className="txt">
                        {(s.brandName ? s.brandName + ' · ' : '') + s.name}
                      </span>
                    </div>
                    <div className="s">
                      {[s.city, s.bizType, p.phone, p.hours, s.address]
                        .filter(Boolean)
                        .join(' · ') || '尚未填写详情'}
                    </div>
                  </div>
                  <div className="gth-actions">
                    <button
                      className="ui-btn gth-btn sm"
                      type="button"
                      onClick={() => startEdit(s)}
                    >
                      编辑
                    </button>
                    <button
                      className="ui-btn is-danger gth-btn sm"
                      type="button"
                      onClick={() => void remove(s)}
                    >
                      删除
                    </button>
                  </div>
                </div>
              )
            })}
          </div>
        )}

        {open ? (
          <div className="gai-store-form">
            <div className="gth-form-grid">
              <label className="gth-field">
                <span className="gth-field-label">品牌名</span>
                <input
                  className="ui-input gth-input"
                  value={form.brandName ?? ''}
                  onChange={(e) => setForm((f) => ({ ...f, brandName: e.target.value }))}
                  placeholder="如 萍姐火锅"
                />
              </label>
              <label className="gth-field">
                <span className="gth-field-label">
                  门店名<span className="req">*</span>
                </span>
                <input
                  className="ui-input gth-input"
                  value={form.name ?? ''}
                  onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
                  placeholder="如 萍姐火锅(春熙路店)"
                />
              </label>
              <label className="gth-field">
                <span className="gth-field-label">城市</span>
                <input
                  className="ui-input gth-input"
                  value={form.city ?? ''}
                  onChange={(e) => setForm((f) => ({ ...f, city: e.target.value }))}
                  placeholder="成都"
                />
              </label>
              <label className="gth-field">
                <span className="gth-field-label">业态</span>
                <input
                  className="ui-input gth-input"
                  value={form.bizType ?? ''}
                  onChange={(e) => setForm((f) => ({ ...f, bizType: e.target.value }))}
                  placeholder="火锅"
                />
              </label>
              <label className="gth-field wide">
                <span className="gth-field-label">详细地址</span>
                <input
                  className="ui-input gth-input"
                  value={form.address ?? ''}
                  onChange={(e) => setForm((f) => ({ ...f, address: e.target.value }))}
                  placeholder="成都市锦江区…"
                />
              </label>
              {PROFILE_KEYS.map((k) => (
                <label className="gth-field" key={k.key}>
                  <span className="gth-field-label">{k.label}</span>
                  <input
                    className="ui-input gth-input"
                    value={form[k.key] ?? ''}
                    onChange={(e) => setForm((f) => ({ ...f, [k.key]: e.target.value }))}
                    placeholder={k.placeholder}
                  />
                </label>
              ))}
            </div>
            <div className="gth-btn-row" style={{ marginTop: 10 }}>
              <button
                className="ui-btn is-primary gth-btn"
                type="button"
                disabled={busy}
                onClick={() => void save()}
              >
                {editing ? '保存修改' : '创建门店'}
              </button>
              <button className="ui-btn gth-btn" type="button" onClick={() => setOpen(false)}>
                取消
              </button>
            </div>
          </div>
        ) : null}
      </SettingsCard>
    </>
  )
}
