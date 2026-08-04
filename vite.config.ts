import { defineConfig } from "vite";
import type { Plugin, ViteDevServer } from "vite";
import react from "@vitejs/plugin-react";
import { spawn } from "node:child_process";
import type { IncomingMessage, ServerResponse } from "node:http";
import { stripVTControlCharacters } from "node:util";
/// <reference types="vitest" />

type MiddlewareNext = (err?: unknown) => void;

// Middleware: POST /api/import-local → spawnt "npm run import:local"
// und streamt den Output zurück. Nur im Dev-Server aktiv.
function importLocalPlugin(): Plugin {
  return {
    name: "import-local",
    configureServer(server: ViteDevServer) {
      server.middlewares.use("/api/import-local", (req: IncomingMessage, res: ServerResponse) => {
        if (req.method !== "POST") { res.statusCode = 405; res.end(); return; }

        res.setHeader("Content-Type", "text/plain; charset=utf-8");
        res.setHeader("Transfer-Encoding", "chunked");
        res.setHeader("Cache-Control", "no-store");

        const stripAnsi = (s: string) => stripVTControlCharacters(s);

        const child = spawn("npm", ["run", "import:local"], {
          cwd: process.cwd(),
          shell: true,
          env: { ...process.env, FORCE_COLOR: "0" },
          windowsHide: true,
        });

        child.stdout?.on("data", (d: Buffer) => res.write(stripAnsi(d.toString())));
        child.stderr?.on("data", (d: Buffer) => res.write(stripAnsi(d.toString())));
        child.on("close", (code: number | null) => {
          res.write(`\n__DONE:${code ?? 1}__`);
          res.end();
        });
        child.on("error", (err: Error) => {
          res.write(`\nFehler beim Starten: ${err.message}\n__DONE:1__`);
          res.end();
        });
      });
    },
  };
}

function noopRefreshRampUpPlugin(): Plugin {
  return {
    name: "noop-refresh-ramp-up",
    configureServer(server: ViteDevServer) {
      server.middlewares.use("/api/refresh-ramp-up", (req: IncomingMessage, res: ServerResponse, next: MiddlewareNext) => {
        if (req.method === "POST") {
          res.statusCode = 204;
          res.end();
          return;
        }
        next();
      });
    }
  };
}

export default defineConfig({
  plugins: [importLocalPlugin(), noopRefreshRampUpPlugin(), react()],
  server: {
    port: 5173,
    open: true,
    proxy: {
      "/api/wms-live": {
        target: "http://127.0.0.1:5001",
        changeOrigin: true,
        rewrite: path => path.replace(/^\/api\/wms-live/, "/hellofresh-de-problem-solve/europe-west3/wmsLive"),
      },
      "/api/refresh-ramp-up": {
        target: "http://127.0.0.1:5001",
        changeOrigin: true,
        rewrite: path => path.replace(/^\/api\/refresh-ramp-up/, "/hellofresh-de-problem-solve/europe-west3/refreshRampUp"),
      },
      // WMS-Einzelendpoints → lokaler Snowflake-Server (npm run wms:server)
      // rewrite entfernt "/api" → Server kennt nur "/wms-*"
      "/api/wms-plating":   { target: "http://127.0.0.1:3141", changeOrigin: true, rewrite: (p: string) => p.replace(/^\/api/, "") },
      "/api/wms-staging":   { target: "http://127.0.0.1:3141", changeOrigin: true, rewrite: (p: string) => p.replace(/^\/api/, "") },
      "/api/wms-debox":     { target: "http://127.0.0.1:3141", changeOrigin: true, rewrite: (p: string) => p.replace(/^\/api/, "") },
      "/api/wms-postblast": { target: "http://127.0.0.1:3141", changeOrigin: true, rewrite: (p: string) => p.replace(/^\/api/, "") },
      "/api/wms-sleeving":  { target: "http://127.0.0.1:3141", changeOrigin: true, rewrite: (p: string) => p.replace(/^\/api/, "") },
      "/api/wms-inbound":   { target: "http://127.0.0.1:3141", changeOrigin: true, rewrite: (p: string) => p.replace(/^\/api/, "") },
      "/api/wms-workorders":{ target: "http://127.0.0.1:3141", changeOrigin: true, rewrite: (p: string) => p.replace(/^\/api/, "") },
    },
  },
  test: {
    environment: "node",
    include: ["src/__tests__/**/*.test.ts"],
  },
  build: {
    outDir: "dist",
    sourcemap: true,
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (id.includes("node_modules/exceljs")) return "excel-workbook-vendor";
          return undefined;
        },
      },
    },
  }
});
