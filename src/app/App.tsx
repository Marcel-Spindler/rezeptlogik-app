import { AppProvider } from "./AppContext";
import { Router } from "./Router";
import { RedzoneProvider } from "../features/redzone-live/RedzoneContext";
import { WoReconciliationProvider } from "../features/wo-reconciliation/WoReconciliationContext";

export default function App() {
  return (
    <RedzoneProvider>
      <AppProvider>
        <WoReconciliationProvider>
          <Router />
        </WoReconciliationProvider>
      </AppProvider>
    </RedzoneProvider>
  );
}
