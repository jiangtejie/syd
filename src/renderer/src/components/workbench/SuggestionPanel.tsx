import { useEffect } from 'react'
import { useWorkbenchStore } from '../../stores/workbench'

/**
 * 建议面板（T7/T8）。
 * 选择会话后自动生成回复候选（LLM 生成）；选用即触发发送（全局串行队列）。
 */
function SuggestionPanel(): React.JSX.Element {
  const activeSessionId = useWorkbenchStore((s) => s.activeSessionId)
  const suggestions = useWorkbenchStore((s) => s.suggestions)
  const suggestLoading = useWorkbenchStore((s) => s.suggestLoading)
  const suggestError = useWorkbenchStore((s) => s.suggestError)
  const chosenText = useWorkbenchStore((s) => s.chosenText)
  const sending = useWorkbenchStore((s) => s.sending)
  const sendResult = useWorkbenchStore((s) => s.sendResult)
  const generateSuggestions = useWorkbenchStore((s) => s.generateSuggestions)
  const adoptSuggestion = useWorkbenchStore((s) => s.adoptSuggestion)
  const agents = useWorkbenchStore((s) => s.agents)
  const defaultAgentId = useWorkbenchStore((s) => s.defaultAgentId)
  const loadAgents = useWorkbenchStore((s) => s.loadAgents)

  // 首次挂载拉取智能体列表（复用已加载结果，不重复请求；store action 引用稳定）
  useEffect(() => {
    void loadAgents()
  }, [loadAgents])

  // 切换会话时重置建议状态；生成由 selectSession 加载完消息后驱动（避免旧消息上下文错乱）
  useEffect(() => {
    useWorkbenchStore.setState({
      suggestions: [],
      suggestError: null,
      chosenText: null,
      sendResult: null
    })
  }, [activeSessionId])

  const noSession = !activeSessionId

  // 统一人设：全端共用一条，此处只展示当前生效人设，编辑入口在设置页
  const persona =
    agents.find((a) => a.id === defaultAgentId) ?? (agents.length === 1 ? agents[0] : undefined)

  return (
    <div className="wb-suggest-panel">
      <div className="wb-suggest-title">
        回复建议
        {suggestions.length > 0 && <span className="wb-suggest-tag wb-suggest-tag-ai">AI</span>}
      </div>

      {!noSession && persona && (
        <div className="wb-suggest-agent">
          <span className="wb-suggest-agent-label">统一人设</span>
          <button
            type="button"
            className="wb-suggest-agent-current"
            title="智能分析/智能回复/IM 通道统一使用此人设；点击到 设置 → AI 助手 中修改"
            onClick={() => useWorkbenchStore.getState().setPage('settings')}
          >
            <b>{persona.name}</b>
            <span className="wb-suggest-agent-edit">修改</span>
          </button>
        </div>
      )}

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
