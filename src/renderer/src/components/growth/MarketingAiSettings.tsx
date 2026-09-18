/**
 * 营销 AI 的通道与策略设置：AI 生图 + 联网搜索。
 *
 * 为什么放在营销页而不是「设置」：这两项配的是营销域能力，语义上和「门店与品牌档案」同级 ——
 * 它们共同决定「这条内容是怎么生成的」。此前生图在 设置→AI 助手、门店品牌在 营销→数据服务，
 * 排查「为什么生成的图和门店对不上」要跨两个页面。
 *
 * 保存语义与设置页一致：开关与下拉即时生效，输入框失焦/回车即存（不需要「保存」按钮）。
 */

import { useState } from 'react'
import { FieldRow, SettingsCard, SwitchRow } from '../settings/ui'
import { useAsyncEffect } from '../../lib/useAsyncEffect'
import { toast } from '../../stores/toast'

const configApi = window.api?.cs?.config

/** 本组件负责的全部配置键（其余键不碰，避免误写） */
interface AiForm {
  'growth.image.enabled': string
  'growth.image.baseUrl': string
  'growth.image.apiKey': string
  'growth.image.model': string
  'growth.image.size': string
  'growth.image.count': string
  'growth.image.platform': string
  'growth.image.templates': string
  'growth.image.monthlyLimit': string
  'growth.search.enabled': string
  'growth.search.provider': string
  'growth.search.apiKey': string
}

const DEFAULTS: AiForm = {
  'growth.image.enabled': '0',
  'growth.image.baseUrl': '',
  'growth.image.apiKey': '',
  'growth.image.model': 'gptimage2',
  // 留空 = 按平台自动（策略层按 xhs/douyin/moments/group 给尺寸）
  'growth.image.size': '',
  'growth.image.count': '2',
  'growth.image.platform': 'xhs',
  'growth.image.templates': '',
  'growth.image.monthlyLimit': '0',
  'growth.search.enabled': '0',
  'growth.search.provider': 'bocha',
  'growth.search.apiKey': ''
}

const boolVal = (v: string): boolean => v === '1' || v === 'true'
const boolStr = (v: boolean): string => (v ? '1' : '0')

export function MarketingAiSettings(): React.JSX.Element {
  const [form, setForm] = useState<AiForm>(DEFAULTS)
  const [loaded, setLoaded] = useState(false)
  const [imgTesting, setImgTesting] = useState(false)
  const [saved, setSaved] = useState(false)

  useAsyncEffect(async () => {
    const all = (await configApi?.getAll().catch(() => null)) as Record<string, string> | null
    if (all) {
      setForm((prev) => {
        const next = { ...prev }
        for (const k of Object.keys(next) as Array<keyof AiForm>) {
          const v = all[k]
          if (v !== undefined && v !== '') next[k] = v
        }
        return next
      })
    }
    setLoaded(true)
  }, [])

  const flash = (): void => {
    setSaved(true)
    window.setTimeout(() => setSaved(false), 1500)
  }

  const patch = (key: keyof AiForm, value: string): void => {
    setForm((prev) => ({ ...prev, [key]: value }))
  }

  /** 开关 / 下拉：一次操作就是一次完整决定 → 立即落库 */
  const setNow = (key: keyof AiForm, value: string): void => {
    patch(key, value)
    if (!configApi || !loaded) return
    void configApi.set(key, value)
    flash()
  }

  /** 输入框：失焦 / 回车落库（半截输入不该被当成配置存进去） */
  const saveField = (key: keyof AiForm, value: string): void => {
    patch(key, value)
    if (!configApi || !loaded) return
    void configApi.set(key, value)
    flash()
  }

  const testImage = async (): Promise<void> => {
    const api = window.api?.cs?.growthai
    if (!api?.testImage) return
    setImgTesting(true)
    try {
      const res = await api.testImage()
      if (res.ok) toast.success('生图通道连通, 测试图已生成')
      else toast.error(res.error || '生图测试失败')
    } finally {
      setImgTesting(false)
    }
  }

  /** 失焦即存的输入框（少写三遍 onBlur/onKeyDown） */
  const field = (key: keyof AiForm): Record<string, unknown> => ({
    value: form[key] ?? '',
    onChange: (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) =>
      patch(key, e.target.value),
    onBlur: (e: React.FocusEvent<HTMLInputElement | HTMLTextAreaElement>) =>
      saveField(key, e.target.value),
    onKeyDown: (e: React.KeyboardEvent<HTMLInputElement | HTMLTextAreaElement>) => {
      if (e.key === 'Enter') saveField(key, e.currentTarget.value)
    }
  })

  return (
    <>
      {saved && <div className="st-saved">已保存</div>}
      <SettingsCard
        title="AI 生图"
        desc="营销工作台里生成封面/氛围图/菜品示意图。支持 OpenAI 兼容的 /images/generations(中转站填其 Base URL 与模型名)。提示词由「生图策略」按平台比例 + 画面模板 + 门店档案(招牌菜/禁用词) + 品牌资料包(定位/语气/主色调)拼装;生成图强制标注「AI 生成示意图」。"
      >
        <SwitchRow
          label="启用 AI 生图"
          desc="关闭后营销工作台里的生图工具会提示去这里开启。"
          checked={boolVal(form['growth.image.enabled'])}
          onChange={(v) => setNow('growth.image.enabled', boolStr(v))}
        />
        {/* 卡内二级分区：通道 vs 策略（.st-subtitle 就是为这种分区准备的） */}
        <div className="st-subtitle">生图通道</div>
        <FieldRow label="接口地址(Base URL)">
          <input
            className="st-input"
            placeholder="https://中转站域名/v1"
            {...field('growth.image.baseUrl')}
          />
        </FieldRow>
        <FieldRow label="API Key">
          <input
            className="st-input"
            type="password"
            placeholder="中转站密钥(本地加密存储)"
            {...field('growth.image.apiKey')}
          />
        </FieldRow>
        <FieldRow label="模型名">
          <input className="st-input" placeholder="gptimage2" {...field('growth.image.model')} />
        </FieldRow>
        <div className="st-subtitle">生图策略</div>
        <FieldRow label="默认平台">
          <select
            className="st-input"
            value={form['growth.image.platform'] ?? 'xhs'}
            onChange={(e) => setNow('growth.image.platform', e.target.value)}
          >
            <option value="xhs">小红书(竖版 2:3)</option>
            <option value="douyin">抖音(竖版 2:3)</option>
            <option value="moments">朋友圈(方版 1:1)</option>
            <option value="group">客户群群发(方版 1:1)</option>
          </select>
        </FieldRow>
        <FieldRow
          label="尺寸"
          hint="留空 = 按平台自动(小红书/抖音竖版 1024x1536、朋友圈方版 1024x1024);填了就一律以它为准"
        >
          <input
            className="st-input"
            placeholder="留空 = 按平台自动"
            {...field('growth.image.size')}
          />
        </FieldRow>
        <FieldRow label="每次张数" hint="单次生成上限(1~4)且是默认张数">
          <input
            className="st-input"
            type="number"
            min={1}
            max={4}
            {...field('growth.image.count')}
          />
        </FieldRow>
        <FieldRow
          label="每月张数上限"
          hint="按自然月统计已生成的 AI 图张数;用尽后生图会被拦下并提示,不会静默失败。0 = 不限"
        >
          <input
            className="st-input"
            type="number"
            min={0}
            max={100000}
            {...field('growth.image.monthlyLimit')}
          />
        </FieldRow>
        <FieldRow label="模板库">
          <textarea
            className="st-input"
            rows={4}
            placeholder='留空 = 内置模板(菜品特写/门店环境/封面氛围/人物场景)。可只改其中一个，如 [{"id":"dish","scene":"本店红油锅底特写，辣椒翻滚"}]'
            {...field('growth.image.templates')}
          />
        </FieldRow>
        <div className="st-hint">
          内置模板 id：dish=菜品特写 · store=门店环境 · cover=封面氛围 · people=人物场景。写同 id
          只覆盖你填的字段；写新 id 会追加成新模板。
        </div>
        <div className="st-actions">
          <button type="button" className="ui-btn" onClick={() => void testImage()}>
            {imgTesting ? '测试中…' : '测试生图(调 1 次接口)'}
          </button>
          <span className="st-hint">测试图不落盘、不进素材库，也不占每月张数</span>
        </div>
      </SettingsCard>

      <SettingsCard
        title="联网搜索"
        desc="营销工作台里 AI 查地址/电话/口碑/菜品参考时使用。结果仅供参考, 地址电话需人工确认后才写入档案。"
      >
        <SwitchRow
          label="启用联网搜索"
          desc="关闭后搜索工具会提示去这里开启。"
          checked={boolVal(form['growth.search.enabled'])}
          onChange={(v) => setNow('growth.search.enabled', boolStr(v))}
        />
        <FieldRow label="供应商">
          <select
            className="st-input"
            value={form['growth.search.provider'] ?? 'bocha'}
            onChange={(e) => setNow('growth.search.provider', e.target.value)}
          >
            <option value="bocha">博查(国内直连)</option>
            <option value="tavily">Tavily</option>
            <option value="serper">Serper</option>
          </select>
        </FieldRow>
        <FieldRow label="API Key">
          <input
            className="st-input"
            type="password"
            placeholder="搜索服务密钥(本地加密存储)"
            {...field('growth.search.apiKey')}
          />
        </FieldRow>
      </SettingsCard>
    </>
  )
}
