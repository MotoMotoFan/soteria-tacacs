import { Component, type ErrorInfo, type ReactNode } from 'react';
import { AlertTriangle } from 'lucide-react';

interface Props {
  children: ReactNode;
  /** Changing this (e.g. the route path) resets the boundary. */
  resetKey?: string;
}
interface State {
  error: Error | null;
  prevKey?: string;
}

// Catches render/lifecycle errors from the subtree so one crashing page shows a
// message instead of blanking the entire app. Auto-resets when resetKey changes
// (route navigation), so leaving the broken page recovers without a reload.
export default class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null, prevKey: undefined };

  static getDerivedStateFromError(error: Error): Partial<State> {
    return { error };
  }

  static getDerivedStateFromProps(props: Props, state: State): Partial<State> | null {
    if (props.resetKey !== state.prevKey) {
      return { error: null, prevKey: props.resetKey };
    }
    return null;
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    // Surface it for debugging; still shows the fallback UI.
    console.error('Page crashed:', error, info.componentStack);
  }

  render() {
    if (!this.state.error) return this.props.children;
    return (
      <div className="glass-card p-8 text-center max-w-lg mx-auto mt-8 space-y-4">
        <div className="w-12 h-12 rounded-full mx-auto flex items-center justify-center" style={{ backgroundColor: 'var(--s-hover)' }}>
          <AlertTriangle className="w-6 h-6" style={{ color: 'var(--s-chart-failure)' }} />
        </div>
        <div className="space-y-1">
          <h2 className="text-lg font-semibold heading">This page hit an error</h2>
          <p className="text-sm" style={{ color: 'var(--s-muted)' }}>
            Something on this page failed to render. The rest of the app is still working, so you can navigate away, or reload to try again.
          </p>
        </div>
        <pre className="text-xs font-mono rounded-lg p-3 text-left overflow-x-auto whitespace-pre-wrap break-all" style={{ backgroundColor: 'var(--s-code-bg)', color: 'var(--s-muted)', border: '1px solid var(--s-border)' }}>
          {this.state.error.message}
        </pre>
        <div className="flex justify-center gap-2">
          <button onClick={() => this.setState({ error: null })} className="btn-secondary text-sm">Try again</button>
          <button onClick={() => window.location.reload()} className="btn-primary text-sm">Reload</button>
        </div>
      </div>
    );
  }
}
