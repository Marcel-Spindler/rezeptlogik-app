import { AppProvider } from "./AppContext";
import { Router } from "./Router";
import { RedzoneProvider } from "../features/redzone-live/RedzoneContext";

export default function App() {
  return (
    <RedzoneProvider>
      <AppProvider>
        <Router />
      </AppProvider>
    </RedzoneProvider>
  );
}
