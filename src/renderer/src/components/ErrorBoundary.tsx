import { Component, type ReactNode } from 'react'

/**
 * 渲染端错误边界：任一组件崩溃时展示兜底页而不是白屏，
 * 可一键重新加载渲染进程。
 */
interface Props {
  children: ReactNode
}

interface State {
  error: Error | null
}

class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null }

  static getDerivedStateFromError(error: Error): State {
    return { error }
  }

  componentDidCatch(error: Error, info: React.ErrorInfo): void {
    console.error('[ErrorBoundary] renderer crashed', error, info.componentStack)
  }

  render(): ReactNode {
    if (this.state.error) {
      return (
        <div className="eb-fallback">
          <div className="eb-title">页面出现异常</div>
          <div className="eb-message">{this.state.error.message}</div>
          <button type="button" className="eb-reload" onClick={() => window.location.reload()}>
            重新加载
          </button>
        </div>
      )
    }
    return this.props.children
  }
}

export default ErrorBoundary
