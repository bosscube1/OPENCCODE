import { Component } from 'react'
import type { ErrorInfo, ReactNode } from 'react'

interface ErrorBoundaryProps {
  /** Names the region that failed, e.g. "Editor" or "Git panel". Shown in the fallback UI. */
  label: string
  children: ReactNode
}

interface ErrorBoundaryState {
  error: Error | null
}

/**
 * Catches render throws from the wrapped subtree so one panel crashing does not
 * white-screen the rest of the app. React error boundaries must be classes —
 * there is no hooks equivalent for componentDidCatch/getDerivedStateFromError.
 */
export class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  override state: ErrorBoundaryState = { error: null }

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { error }
  }

  override componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error(`[ErrorBoundary:${this.props.label}]`, error, info.componentStack)
  }

  reset = (): void => {
    this.setState({ error: null })
  }

  override render(): ReactNode {
    const { error } = this.state
    if (error === null) return this.props.children

    return (
      <div className="app__crash">
        <div className="app__crash-label">{this.props.label} crashed</div>
        <pre className="app__crash-msg">{error.message || String(error)}</pre>
        <button type="button" className="app__btn app__btn--primary" onClick={this.reset}>
          Try again
        </button>
      </div>
    )
  }
}
