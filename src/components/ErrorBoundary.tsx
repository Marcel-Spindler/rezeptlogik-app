import { Component, type ErrorInfo, type ReactNode } from "react";

interface Props {
  children: ReactNode;
  fallback?: ReactNode;
  /** Ändert sich dieser Wert (z.B. die aktive View), wird ein gefangener Fehler
   *  zurückgesetzt — sonst bliebe die Fehler-Kachel auch nach Navigation stehen. */
  resetKey?: unknown;
  /** Kontext-Label für die Konsolen-/Log-Ausgabe. */
  label?: string;
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

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error(`[ErrorBoundary${this.props.label ? " · " + this.props.label : ""}]`, error, info.componentStack);
  }

  componentDidUpdate(prev: Props) {
    if (this.state.hasError && prev.resetKey !== this.props.resetKey) {
      this.setState({ hasError: false, error: null });
    }
  }

  render() {
    if (this.state.hasError) {
      return this.props.fallback ?? (
        <div className="card p-8 text-center">
          <div className="text-lg font-medium text-red-700">Darstellungsfehler</div>
          <p className="mt-2 text-sm text-slate-600">In dieser Ansicht ist ein Fehler aufgetreten. Die übrige App läuft weiter.</p>
          <pre className="mt-3 max-h-32 overflow-auto rounded bg-slate-100 p-3 text-left text-xs text-slate-700">{this.state.error?.message}</pre>
          <div className="mt-4 flex justify-center gap-2">
            <button type="button" className="btn" onClick={() => this.setState({ hasError: false, error: null })}>Erneut versuchen</button>
            <button type="button" className="btn" onClick={() => window.location.reload()}>Seite neu laden</button>
          </div>
        </div>
      );
    }
    return this.props.children;
  }
}
