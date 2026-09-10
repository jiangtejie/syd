import { toast } from '../stores/toast'

/**
 * 「标记为团队客服」就地入口（监控抽屉 / 群问题面板的证据时间线里用）。
 *
 * 为什么需要：跟进判定要回答「这条议题的客户有没有人应过」，而引擎只能靠 team_member 名单
 * 区分「客户」与「我方同事」。同事没被标记时，TA 的回复会被当成客户发言 →
 * 议题永远停在「待处理」（实测某群 陈丽竹 回复后状态不动）。
 * 以前只有对话页右键能标，用户在监控页看到同事回复时无从下手，这里补上。
 */
export function TeamMarkButton({
  wxid,
  username,
  displayName,
  marked,
  onMarked
}: {
  wxid: string
  username?: string
  displayName: string
  marked: boolean
  onMarked?: () => void
}): React.JSX.Element | null {
  if (!username || marked || !wxid) return null
  const mark = async (): Promise<void> => {
    const res = await window.api?.cs?.team?.save(wxid, username).catch(() => null)
    if (!res?.ok) {
      toast.error(res?.error || '标记失败')
      return
    }
    toast.success(`已把 ${displayName} 标记为团队客服：后续判定会把 TA 的发言算作我方回复`)
    onMarked?.()
  }
  return (
    <button
      type="button"
      className="tm-mark"
      title="TA 是我方同事（客服）:标记后 TA 的发言会被算作我方回复,议题会进入「跟进中」"
      onClick={(e) => {
        e.stopPropagation()
        void mark()
      }}
    >
      标记同事
    </button>
  )
}
