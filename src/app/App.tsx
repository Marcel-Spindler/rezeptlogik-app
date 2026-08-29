import { AppProvider } from "./AppContext";
import { Router } from "./Router";
import { RedzoneProvider } from "../features/redzone-live/RedzoneContext";
import { WoReconciliationProvider } from "../features/wo-reconciliation/WoReconciliationContext";
import { BackfillsProvider } from "../features/backfills/BackfillsContext";
import { ErrorBoundary } from "../components/ErrorBoundary";

export default function App() {
  return (
    <ErrorBoundary label="app-root">
      <RedzoneProvider>
        <AppProvider>
          <WoReconciliationProvider>
            <BackfillsProvider>
              <Router />
            </BackfillsProvider>
          </WoReconciliationProvider>
        </AppProvider>
      </RedzoneProvider>
    </ErrorBoundary>
  );
}
