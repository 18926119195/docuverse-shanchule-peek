import { Component, type ErrorInfo, type ReactNode } from 'react'

type Props = { children: ReactNode }
type State = { error: Error | null }

/** Keep TOC wizard failures from unmounting the 3D stage (WebGL). */
export class TocWizardBoundary extends Component<Props, State> {
  state: State = { error: null }

  static getDerivedStateFromError(error: Error): State {
    return { error }
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error('[TocWizard]', error, info.componentStack)
  }

  render() {
    const { error } = this.state
    if (error) {
      return (
        <div className="toc-wizard-backdrop" role="alert">
          <div className="toc-wizard toc-wizard-error-panel">
            <p className="toc-wizard-title">建库向导暂时出错</p>
            <p className="toc-wizard-p">{error.message}</p>
            <p className="toc-wizard-sub">
              3D 场景应仍可用。请点重试；若仍失败请 Ctrl+F5 刷新页面。
            </p>
            <button
              type="button"
              className="fanout-btn primary"
              onClick={() => this.setState({ error: null })}
            >
              重试向导
            </button>
          </div>
        </div>
      )
    }
    return this.props.children
  }
}
