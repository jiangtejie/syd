import { useCallback, useEffect, useState } from 'react'
import { toast } from '../stores/toast'
import GrowthAiWorkbench from './GrowthAiWorkbench'
import StoresCard from '../components/growth/StoresCard'
import BuzzPanel from '../components/growth/BuzzPanel'
import { growthApi } from '../components/growth/meta'
import { StatsBar } from '../components/growth/StatsBar'
import { WarehousePanel } from '../components/growth/WarehousePanel'
import { MarketingAiSettings } from '../components/growth/MarketingAiSettings'
import { useWorkbenchStore, type GrowthTab } from '../stores/workbench'
import type { GrowthStats } from '../../../shared/growth'
import './growth.css'
import './growth/forms.css'
import './growth/tables.css'
import './growth/panels.css'
import './growth/buzz.css'
import './growth/polish.css'

/**
 * 营销增长页: 素材仓库 / AI 工作台 / 舆情 / 设置(门店品牌 · AI 生图)。
 * 对齐仓库页面规范(page-scroll/page-title/page-card), 无 mock 数据;
 * 空态给引导步骤, 失败给错误条 + 重试。
 *
 * 注: 原「采集源」页签与第三方数据服务商配置已随采集链路下线删除 —— 适配器注册表从未被注册过，
 * 这条链路在结构上不可能成功（见 ARCHITECTURE §9）。入库仍有两条真能用的路：
 * 粘贴分享链接解析、本地图片/视频导入。
 * 注: 联网搜索（搜索工具 + 配置卡）也已下线待重新设计（目标是「商家综合信息 + 菜品信息」）。
 *
 * 拆分层级(2026-09 结构整理):本文件只留页面外壳 —— 页签 + 各面板的拼装;
 * 面板实现见 components/growth/{common,StatsBar,WarehousePanel,BuzzPanel,StoresCard,MediaGallery}.tsx。
 */

/**
 * 每个页签一句话（**必须是一行**，页头右侧单行省略显示）。
 *
 * 此前这里是 40~90 字的长句，渲染出来要占两行、把页头撑成一块；
 * 细节说明放各屏自己的空态里（那里才是用户真正需要它的时候）。
 */
const TAB_DESC: Record<GrowthTab, string> = {
  warehouse: '粘贴链接入库、检索筛选、批量导出发布包',
  ai: '与 AI 对话逐项改标题/正文/配图，产出点选采用',
  buzz: '门店相关内容的情绪评级与根因诊断',
  provider: '门店与品牌档案、AI 生图通道与生图策略'
}

export default function GrowthPage(): React.JSX.Element {
  // 页签放全局 store：设置页要能跳过来直接落在「设置」屏（同「监控」的 monitorTab 口径）
  const tab = useWorkbenchStore((s) => s.growthTab)
  const setTab = useWorkbenchStore((s) => s.setGrowthTab)
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
  const openWorkbenchForContent = useCallback(
    async (contentId: number): Promise<void> => {
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
      // setTab 来自 store（引用稳定），依赖里列上以免 eslint 报 missing dependency
    },
    [setTab]
  )

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
          <h2 className={'page-title'}>营销</h2>
          <div className={'gth-hero-side'}>
            {/* 注: 原「自动采集运行中/未开启」与「最近采集」两个胶囊随采集链路下线删除 */}
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
        {/* 页签 + 一行说明：说明随页签变，右侧单行省略（长说明会把页头撑成两行） */}
        <div className={'gth-hero-tabs'}>
          <div className={'gth-seg'}>
            {(['warehouse', 'ai', 'buzz', 'provider'] as GrowthTab[]).map((k, i) => (
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
                      : '设置'}
              </button>
            ))}
          </div>
          <span className={'gth-hero-desc'}>{TAB_DESC[tab]}</span>
        </div>
      </div>
      {/* 四个统计卡(仓库素材/采集订阅/媒体文件/数据服务商)说的是"采集管线健康度"，
          只在管线相关的三屏显示(设置/采集源/素材仓库)。
          「AI 工作台」是对话改稿、「舆情」有自己的情绪统计行(gth-buzz-stats)，都不需要这四个卡；
          AI 工作台省下的高度还给对话区(见 growth-ai.css 的 .gai-page)。 */}
      {tab === 'provider' || tab === 'warehouse' ? <StatsBar stats={stats} /> : null}
      {tab === 'provider' ? (
        /* 设置屏两栏：左「门店与品牌」（AI 的事实来源），右「AI 生图通道与策略」。
           此前是三个整宽卡片竖排，宽屏上每张卡的输入框都拉成 1000+px 一条，
           右侧一大片留白、纵向还得滚三轮才看完。 */
        <div className={'gth-set-grid'}>
          <StoresCard />
          {/* 营销 AI 的通道与策略：和门店/品牌档案同屏 —— 它们共同决定"内容怎么生成" */}
          <MarketingAiSettings />
        </div>
      ) : null}
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
