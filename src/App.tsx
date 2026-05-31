import { AppProvider } from "./AppContext";
import { Router } from "./Router";

export default function App() {
  return (
    <AppProvider>
      <Router />
    </AppProvider>
  );
}
