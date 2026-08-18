import { Component, type ReactNode } from "react";

interface Props {
  children: ReactNode;
  fallback?: ReactNode;
}

interface State {
  hasError: boolean;
  error: Error | null;
}

export class ErrorBoundary extends Component<Props, State> {
  state: State = { hasError: false, error: null };

  static getDerivedStateFromError(error: Error): State {
    return { hasError: true, error };
  }

  render() {
    if (this.state.hasError) {
      return this.props.fallback ?? (
        <div className="card p-8 text-center">
          <div className="text-lg font-medium text-red-700">Darstellungsfehler</div>
          <p className="mt-2 text-sm text-slate-600">In dieser Ansicht ist ein Fehler aufgetreten.</p>
          <pre className="mt-3 max-h-32 overflow-auto rounded bg-slate-100 p-3 text-left text-xs text-slate-700">{this.state.error?.message}</pre>
          <button type="button" className="btn mt-4" onClick={() => this.setState({ hasError: false, error: null })}>Erneut versuchen</button>
        </div>
      );
    }
    return this.props.children;
  }
}
