import { useCallback, useEffect, useState } from 'react'
import { toast } from '../stores/toast'
import GrowthAiWorkbench from './GrowthAiWorkbench'
import StoresCard from '../components/growth/StoresCard'
import BuzzPanel from '../components/growth/BuzzPanel'
import { growthApi, fmt } from '../components/growth/meta'
import { StatsBar } from '../components/growth/StatsBar'
import { ProviderPanel } from '../components/growth/ProviderPanel'
import { SourcesPanel } from '../components/growth/SourcesPanel'
import { WarehousePanel } from '../components/growth/WarehousePanel'
import type { GrowthStats } from '../../../shared/growth'
import './growth.css'
import './growth/forms.css'
import './growth/tables.css'
import './growth/panels.css'
import './growth/buzz.css'
import './growth/polish.css'

/**
 * 营销增长页: 采集源 / 素材仓库 / 数据服务。
 * 对齐仓库页面规范(page-scroll/page-title/page-card), 无 mock 数据;
 * 空态给引导步骤, 失败给错误条 + 重试, 长任务经 cs:growth:progress 推送。
 *
 * 拆分层级(2026-09 结构整理):本文件只留页面外壳 —— 页签 + 各面板的拼装;
 * 面板实现见 components/growth/{common,StatsBar,ProviderPanel,SourcesPanel,WarehousePanel,MediaGallery}.tsx。
 */

type GrowthTab = 'provider' | 'sources' | 'warehouse' | 'ai' | 'buzz'

const TAB_DESC: Record<GrowthTab, string> = {
  buzz: '门店舆情监控: 跟踪抖音/小红书上的门店相关内容, 结合正文与评论区高赞做情绪评级与根因诊断',
  ai: '任务式爆改工作台: 左边素材任务列表, 右边与 AI 对话逐项改标题/正文/配图, 右侧产出面板点选采用',
  sources: '订阅同城/同行的爆款内容源, 由第三方数据服务定时拉取入库',
  warehouse:
    '本地爆款素材仓库: 粘贴链接/口令入库、检索与筛选、批量改用途/状态/删除、批量导出发布包; AI 拆解与爆改在「AI 工作台」进行(详情里可一键跳过去)',
  provider: '第三方数据服务商与自动采集总开关(适配器 Phase 1 接入)'
}

export default function GrowthPage(): React.JSX.Element {
  const [tab, setTab] = useState<GrowthTab>('warehouse')
  const [stats, setStats] = useState<GrowthStats | null>(null)
  /** 从素材仓库跳转 AI 工作台时携带的任务 id */
  const [aiFocusTask, setAiFocusTask] = useState<number | null>(null)

  const loadStats = useCallback((): void => {
    if (!growthApi) return
    growthApi.stats().then((res) => {
      if (res.ok && res.stats) setStats(res.stats)
    })
  }, [])

  useEffect(() => {
    loadStats()
  }, [loadStats])

  /**
   * 素材仓库 → AI 工作台：**先找已有任务，没有再建**（一个素材一个任务）。
   * 直接调 createTask 会在重复点击时堆出一串同名任务，所以这里以 contentId 去重。
   */
  const openWorkbenchForContent = useCallback(async (contentId: number): Promise<void> => {
    const ai = window.api?.cs?.growthai
    if (!ai) {
      toast.error('AI 工作台不可用(请重启应用以加载最新主进程)')
      return
    }
    const list = await ai.listTasks()
    const tasks = (list.ok ? (list.tasks ?? []) : []) as Array<{ id: number; contentId: number }>
    const existing = tasks.find((t) => t.contentId === contentId)
    if (existing) {
      setAiFocusTask(existing.id)
      setTab('ai')
      return
    }
    const res = await ai.createTask({ contentId })
    if (!res.ok || !res.taskId) {
      toast.error(res.error ?? '创建爆改任务失败')
      return
    }
    setAiFocusTask(res.taskId)
    setTab('ai')
  }, [])

  useEffect(() => {
    if (!growthApi?.onProgress) return
    const unsub = growthApi.onProgress((p) => {
      if (p.kind === 'crawl') {
        if (p.status === 'done') toast.success('采集完成: ' + p.detail)
        else if (p.status === 'error') toast.error('采集失败: ' + p.detail)
      }
      loadStats()
    })
    return unsub
  }, [loadStats])

  if (!growthApi) {
    return (
      <div className={'page-scroll gth-page'}>
        <h2 className={'page-title'}>营销</h2>
        <div className={'gth-error'}>增长 API 不可用(请在完整应用环境中使用)</div>
      </div>
    )
  }

  return (
    <div className={'page-scroll gth-page'}>
      <div className={'gth-hero'}>
        <div className={'gth-hero-top'}>
          <span className={'gth-hero-logo'}>
            <svg
              width={'19'}
              height={'19'}
              viewBox={'0 0 24 24'}
              fill={'none'}
              stroke={'currentColor'}
              strokeWidth={'1.9'}
              strokeLinecap={'round'}
              strokeLinejoin={'round'}
            >
              <path d={'M4 15.5 9 10l3.4 3.2L20 6'} />
              <path d={'M15.4 6H20v4.6'} />
              <path d={'M4 20h16'} />
            </svg>
          </span>
          <div className={'gth-hero-text'}>
            <h2 className={'page-title'}>营销</h2>
            <div className={'page-subtitle'}>{TAB_DESC[tab]}</div>
          </div>
          <div className={'gth-hero-side'}>
            {stats ? (
              stats.autoEnabled ? (
                <span className={'gth-hero-chip on'} title={'按订阅节奏自动拉取'}>
                  <span className={'dot'} />
                  自动采集运行中
                </span>
              ) : (
                <span className={'gth-hero-chip warn'} title={'到「数据服务」开启总开关'}>
                  <span className={'dot'} />
                  自动采集未开启
                </span>
              )
            ) : null}
            {stats?.lastCrawlAt ? (
              <span className={'gth-hero-chip'}>最近采集 {fmt(stats.lastCrawlAt)}</span>
            ) : null}
            <button
              className={'ui-btn gth-btn sm'}
              type={'button'}
              onClick={loadStats}
              title={'刷新指标'}
            >
              刷新
            </button>
          </div>
        </div>
        <div className={'gth-seg'}>
          {(['warehouse', 'ai', 'buzz', 'sources', 'provider'] as GrowthTab[]).map((k, i) => (
            <button
              key={k}
              type={'button'}
              className={'gth-seg-btn' + (tab === k ? ' is-active' : '')}
              style={{ '--i': i } as React.CSSProperties}
              onClick={() => setTab(k)}
            >
              {k === 'warehouse'
                ? '素材仓库'
                : k === 'ai'
                  ? 'AI 工作台'
                  : k === 'buzz'
                    ? '舆情'
                    : k === 'sources'
                      ? '采集源'
                      : '数据服务'}
            </button>
          ))}
          <span className={'gth-seg-hint'}>AI 工作台 = 任务式爆改(对话驱动)</span>
        </div>
      </div>
      {/* 四个统计卡(仓库素材/采集订阅/媒体文件/数据服务商)说的是"采集管线健康度"，
          只在管线相关的三屏显示(数据服务/采集源/素材仓库)。
          「AI 工作台」是对话改稿、「舆情」有自己的情绪统计行(gth-buzz-stats)，都不需要这四个卡；
          AI 工作台省下的高度还给对话区(见 growth-ai.css 的 .gai-page)。 */}
      {tab === 'provider' || tab === 'sources' || tab === 'warehouse' ? (
        <StatsBar stats={stats} />
      ) : null}
      {tab === 'provider' ? (
        <>
          <ProviderPanel onChanged={loadStats} />
          <StoresCard />
        </>
      ) : null}
      {tab === 'sources' ? <SourcesPanel onChanged={loadStats} /> : null}
      {tab === 'warehouse' ? (
        <WarehousePanel
          onChanged={loadStats}
          onOpenWorkbench={(cid) => void openWorkbenchForContent(cid)}
        />
      ) : null}
      {tab === 'buzz' ? (
        <BuzzPanel
          onChanged={loadStats}
          onOpenWorkbench={(taskId) => {
            setAiFocusTask(taskId)
            setTab('ai')
          }}
        />
      ) : null}
      {tab === 'ai' ? (
        <GrowthAiWorkbench
          focusTaskId={aiFocusTask}
          onFocusConsumed={() => setAiFocusTask(null)}
          onChanged={loadStats}
        />
      ) : null}
    </div>
  )
}
