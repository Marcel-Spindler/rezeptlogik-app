import React, { Suspense } from "react";
import ReactDOM from "react-dom/client";
import App from "./app/App";
import { ErrorBoundary } from "./components/ErrorBoundary";
import { lazyWithRetry } from "./lib/lazyWithRetry";
import "./index.css";

const ShareDashboard = lazyWithRetry(
  () => import("./ShareDashboard").then(m => ({ default: m.ShareDashboard })),
  "share-dashboard",
);

const shareWeek = new URLSearchParams(window.location.search).get("share");

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    {shareWeek ? (
      <ErrorBoundary label="share-dashboard">
        <Suspense
          fallback={
            <div style={{
              minHeight: "100vh", display: "flex", alignItems: "center",
              justifyContent: "center",
              background: "linear-gradient(135deg,#0f172a 0%,#1e1b4b 50%,#0f172a 100%)",
            }}>
              <div style={{ color: "#a5b4fc", fontSize: "1.125rem", fontFamily: "system-ui,sans-serif" }}>
                Lade …
              </div>
            </div>
          }
        >
          <ShareDashboard week={shareWeek} />
        </Suspense>
      </ErrorBoundary>
    ) : (
      <App />
    )}
  </React.StrictMode>
);
