import { useEffect } from 'react'
import { useWorkbenchStore } from '../../stores/workbench'

/**
 * 建议面板（T7/T8）。
 * 选择会话后自动生成回复候选（模板直答优先 / LLM 生成）；选用即触发发送（全局串行队列）。
 */
function SuggestionPanel(): React.JSX.Element {
  const activeSessionId = useWorkbenchStore((s) => s.activeSessionId)
  const suggestions = useWorkbenchStore((s) => s.suggestions)
  const suggestLoading = useWorkbenchStore((s) => s.suggestLoading)
  const suggestError = useWorkbenchStore((s) => s.suggestError)
  const suggestLlm = useWorkbenchStore((s) => s.suggestLlm)
  const chosenText = useWorkbenchStore((s) => s.chosenText)
  const sending = useWorkbenchStore((s) => s.sending)
  const sendResult = useWorkbenchStore((s) => s.sendResult)
  const generateSuggestions = useWorkbenchStore((s) => s.generateSuggestions)
  const adoptSuggestion = useWorkbenchStore((s) => s.adoptSuggestion)

  // 切换会话时重置建议状态；生成由 selectSession 加载完消息后驱动（避免旧消息上下文错乱）
  useEffect(() => {
    useWorkbenchStore.setState({
      suggestions: [],
      suggestError: null,
      suggestLlm: false,
      chosenText: null,
      sendResult: null
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeSessionId])

  const noSession = !activeSessionId

  return (
    <div className="wb-suggest-panel">
      <div className="wb-suggest-title">
        智能建议
        {suggestLlm && <span className="wb-suggest-tag wb-suggest-tag-ai">AI</span>}
        {suggestions.length > 0 && !suggestLlm && (
          <span className="wb-suggest-tag wb-suggest-tag-kb">知识库</span>
        )}
      </div>

      {noSession && (
        <div className="wb-suggest-empty">选择会话后，这里会展示 AI 生成的回复建议</div>
      )}

      {!noSession && suggestLoading && <div className="wb-suggest-empty">正在生成建议…</div>}

      {!noSession && !suggestLoading && suggestError && (
        <div className="wb-suggest-error">{suggestError}</div>
      )}

      {!noSession && !suggestLoading && !suggestError && suggestions.length === 0 && (
        <div className="wb-suggest-empty">暂无建议，可以点击下方按钮重新生成</div>
      )}

      {sendResult && (
        <div className={`wb-send-result ${sendResult.ok ? 'is-ok' : 'is-fail'}`}>
          {sendResult.ok
            ? `已发送${sendResult.verified === false ? '（未校验）' : ''}`
            : `发送失败：${sendResult.error || sendResult.status}`}
          {sendResult.status === 'halted' && '（系统熔断）'}
        </div>
      )}

      {suggestions.length > 0 && (
        <div className="wb-suggest-list">
          {suggestions.map((c, i) => {
            const chosen = chosenText === c.text
            const sentOk = chosen && sendResult?.ok === true
            const label = chosen && sending ? '发送中…' : sentOk ? '已发送' : '选用并发送'
            return (
              <div
                key={`${i}-${c.text.slice(0, 12)}`}
                className={`wb-suggest-card${sentOk ? ' is-chosen' : ''}`}
              >
                <div className="wb-suggest-card-head">
                  <span className="wb-suggest-src">
                    {c.source === 'kb_direct' ? '知识库直答' : 'AI 生成'}
                  </span>
                  {c.reason && <span className="wb-suggest-reason">{c.reason}</span>}
                </div>
                <div className="wb-suggest-text">{c.text}</div>
                <div className="wb-suggest-actions">
                  <button
                    type="button"
                    className="wb-suggest-btn"
                    disabled={sending}
                    onClick={() => adoptSuggestion(c.text)}
                  >
                    {label}
                  </button>
                </div>
              </div>
            )
          })}
        </div>
      )}

      {!noSession && (
        <button
          type="button"
          className="wb-suggest-regenerate"
          disabled={suggestLoading}
          onClick={() => void generateSuggestions()}
        >
          重新生成
        </button>
      )}
    </div>
  )
}

export default SuggestionPanel
