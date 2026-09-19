import type { GrowthDecompSummary } from '../../../../shared/growth'

/**
 * AI 拆解卡（素材详情内）。
 *
 * 为什么要有它：拆解卡此前**只写给模型看**（itemBrief 塞进 system），界面上只有一枚
 * 「已拆解/待拆解」徽标 —— 用户看不到 AI 到底从这条爆款里读出了什么，也就无从判断
 * 爆改/生图的方向对不对。视觉维度尤其：图生图的「保持」清单直接取自它，
 * 不显示出来，用户就不知道那张图为什么改成了这个版式。
 */

/** 拆解卡版本：v2 起带视觉拆解（见 remix/service.ts 的 ANALYZE_VER） */
const VISUAL_VER = 'analyze-v2'

const STRUCT_FIELDS: ReadonlyArray<{ key: string; label: string }> = [
  { key: 'hook', label: '钩子' },
  { key: 'structure', label: '正文骨架' },
  { key: 'sellingPoints', label: '卖点' },
  { key: 'titlePatterns', label: '标题套路' },
  { key: 'commentTopics', label: '评论关注点' },
  { key: 'whyWorks', label: '为什么能火' }
]

/**
 * 视觉维度。前 6 项都是短值（"90 度俯拍"这种），走两列网格；后 2 项（元素清单、图上原文）
 * 可能很长，占满一行 —— 原来是 8 行竖排，详情卡本来就窄，一路排下来把整卡撑得很长。
 */
const VISUAL_FIELDS: ReadonlyArray<{ key: string; label: string; wide?: boolean }> = [
  { key: 'composition', label: '构图' },
  { key: 'camera', label: '机位' },
  { key: 'lighting', label: '光线' },
  { key: 'colorTone', label: '色调' },
  { key: 'layout', label: '版式留白' },
  { key: 'subjectRatio', label: '主体占比' },
  { key: 'elements', label: '画面元素', wide: true },
  { key: 'textInImage', label: '图上文字', wide: true }
]

/** 值可能是字符串/数组（模型两种都给过），统一成一行可读文本；空值返回 '' */
function asLine(v: unknown): string {
  if (v === null || v === undefined || v === '') return ''
  if (Array.isArray(v)) {
    return v
      .map((x) => (typeof x === 'string' ? x : JSON.stringify(x)))
      .filter(Boolean)
      .join('、')
  }
  if (typeof v === 'string') return v.trim()
  if (typeof v === 'number' || typeof v === 'boolean') return String(v)
  return ''
}

function Rows({
  source,
  fields
}: {
  source: Record<string, unknown> | null
  fields: ReadonlyArray<{ key: string; label: string }>
}): React.JSX.Element {
  const rows = fields
    .map((f) => ({ label: f.label, text: asLine(source?.[f.key]) }))
    .filter((r) => r.text)
  if (rows.length === 0) return <div className={'gth-decomp-empty'}>（本版本没有这部分内容）</div>
  return (
    <>
      <div className={'gth-decomp-list'}>
        {rows.map((r) => (
          <div className={'gth-decomp-row'} key={r.label}>
            <span className={'k'}>{r.label}</span>
            <span className={'v'}>{r.text}</span>
          </div>
        ))}
      </div>
    </>
  )
}

export function DecompCard({ decomp }: { decomp: GrowthDecompSummary | null }): React.JSX.Element {
  if (!decomp) {
    return (
      <div className={'gth-decomp'}>
        <div className={'gth-decomp-h'}>AI 拆解卡</div>
        <div className={'gth-decomp-empty'}>
          尚未拆解。到「AI 工作台」为这条素材新建任务时会自动拆解一次 ——
          拆解卡是爆改与图生图的事实来源（改标题、照版式出图都靠它）。
        </div>
      </div>
    )
  }
  const visual = decomp.visual
  const visualOk = !!visual && Object.keys(visual).length > 0
  return (
    <div className={'gth-decomp'}>
      <div className={'gth-decomp-h'}>
        AI 拆解卡
        <span className={'v'}>{decomp.modelVer || '未知版本'}</span>
      </div>
      <Rows source={decomp.structure} fields={STRUCT_FIELDS} />
      <div className={'gth-decomp-vis'}>
        <div className={'gth-decomp-vis-h'}>
          视觉拆解
          {visualOk ? (
            <span className={'tag'}>图生图据此锁定「保持」</span>
          ) : (
            <span className={'tag gray'}>
              {decomp.modelVer !== VISUAL_VER ? '旧版卡，重建任务时自动补' : '本次未读出画面维度'}
            </span>
          )}
        </div>
        {visualOk ? (
          <div className={'gth-decomp-grid'}>
            {VISUAL_FIELDS.map((f) => {
              const text = asLine(visual?.[f.key])
              if (!text) return null
              return (
                <div
                  className={'gth-decomp-cell' + (f.wide ? ' wide' : '')}
                  key={f.key}
                  title={text}
                >
                  <span className={'k'}>{f.label}</span>
                  <span className={'v'}>{text}</span>
                </div>
              )
            })}
          </div>
        ) : (
          <div className={'gth-decomp-empty'}>
            没有画面维度时，图生图的「保持」只能用通用口径（构图/机位/光线不具体），
            改出来未必是同一个版式。
          </div>
        )}
      </div>
    </div>
  )
}

export default DecompCard
