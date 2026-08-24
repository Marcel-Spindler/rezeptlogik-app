import { defineConfig } from "vite";
import type { Plugin, ViteDevServer } from "vite";
import react from "@vitejs/plugin-react";
import { spawn } from "node:child_process";
import { copyFileSync, existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import type { Dirent } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { createConnection } from "node:net";
import { extname, join, resolve } from "node:path";
import { stripVTControlCharacters } from "node:util";
/// <reference types="vitest" />

type MiddlewareNext = (err?: unknown) => void;

function isPortOpen(port: number): Promise<boolean> {
  return new Promise(resolve => {
    const socket = createConnection({ host: "127.0.0.1", port });
    socket.once("connect", () => { socket.destroy(); resolve(true); });
    socket.once("error", () => { socket.destroy(); resolve(false); });
  });
}

// WMS-Endpoints werden vom lokalen Snowflake-Server auf Port 3141 bereitgestellt.
// Der Vite-Server besitzt den Prozess nur, wenn er ihn selbst gestartet hat;
// ein separat laufender `npm run wms:server` wird deshalb nie beendet.
function autoStartWmsPlugin(): Plugin {
  return {
    name: "auto-start-wms-server",
    async configureServer(server: ViteDevServer) {
      if (await isPortOpen(3141)) return;

      const child = spawn("npx", ["tsx", "scripts/wms-local-server.ts"], {
        cwd: process.cwd(),
        shell: true,
        env: { ...process.env, FORCE_COLOR: "0" },
        windowsHide: true,
        stdio: "inherit",
      });
      console.log("[wms] Lokaler WMS-Server wird automatisch gestartet (Port 3141).");

      server.httpServer?.once("close", () => {
        if (!child.killed) child.kill();
      });
    },
  };
}

function autoStartLocalDbPlugin(): Plugin {
  return {
    name: "auto-start-local-db-server",
    async configureServer(server: ViteDevServer) {
      if (await isPortOpen(3142)) return;

      const child = spawn(process.execPath, ["scripts/local-db-server.mjs"], {
        cwd: process.cwd(),
        shell: false,
        env: { ...process.env, FORCE_COLOR: "0" },
        windowsHide: true,
        stdio: "inherit",
      });
      child.on("error", (error) => console.error(`[local-db] Start fehlgeschlagen: ${error.message}`));
      console.log("[local-db] SQLite/Gemini-Server wird automatisch gestartet (Port 3142).");

      server.httpServer?.once("close", () => {
        if (!child.killed) child.kill();
      });
    },
  };
}

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
          if (code === 0) {
            res.write("\n── Pushing to Firestore…\n");
            const push = spawn("npm", ["run", "push:firestore"], {
              cwd: process.cwd(),
              shell: true,
              env: { ...process.env, FORCE_COLOR: "0" },
              windowsHide: true,
            });
            push.stdout?.on("data", (d: Buffer) => res.write(stripAnsi(d.toString())));
            push.stderr?.on("data", (d: Buffer) => res.write(stripAnsi(d.toString())));
            push.on("close", (pushCode: number | null) => {
              res.write(`\n__DONE:${pushCode ?? 1}__`);
              res.end();
            });
            push.on("error", (err: Error) => {
              res.write(`\nFehler push:firestore: ${err.message}\n__DONE:1__`);
              res.end();
            });
          } else {
            res.write(`\n__DONE:${code ?? 1}__`);
            res.end();
          }
        });
        child.on("error", (err: Error) => {
          res.write(`\nFehler beim Starten: ${err.message}\n__DONE:1__`);
          res.end();
        });
      });
      server.middlewares.use("/api/push-firestore", (req: IncomingMessage, res: ServerResponse) => {
        if (req.method !== "POST") { res.statusCode = 405; res.end(); return; }

        res.setHeader("Content-Type", "text/plain; charset=utf-8");
        res.setHeader("Transfer-Encoding", "chunked");
        res.setHeader("Cache-Control", "no-store");

        const stripAnsi = (s: string) => stripVTControlCharacters(s);

        const child = spawn("npm", ["run", "push:firestore"], {
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

const DRIVE_SOURCE_DIR = resolve("G:/.shortcut-targets-by-id/1tSHOPlJpN0vslaIY2JyAEa3gJQT603IF/Factor EU Meal Images");

function folderMatchesMealId(folderName: string, mealId: string): boolean {
  // Extract the 4-digit number from the meal code (e.g. "FV0047A" → "0047")
  const digits = mealId.match(/\d{4}/)?.[0];
  if (!digits) return false;
  // Match any folder whose name contains exactly these 4 digits (not part of a longer number)
  return new RegExp(`(?<!\\d)${digits}(?!\\d)`).test(folderName);
}

function scoreDriveFile(filename: string): number {
  const lower = filename.toLowerCase();
  const isSA = lower.includes("_sa_") || lower.includes("_sa ") || lower.endsWith("_sa_low.jpg") || lower.endsWith("_sa_high.jpg");
  const isTray = lower.includes("_tray_");
  const isLow = lower.includes("low");
  if (isSA && isLow) return 10;
  if (isSA && !isLow) return 8;
  if (isTray && isLow) return 6;
  if (isTray && !isLow) return 4;
  return 1;
}

function imageLabelFromName(filename: string): string {
  const lower = filename.toLowerCase();
  if (lower.includes("_sa_")) return "SA";
  if (lower.includes("_tray_")) return "Tray";
  if (lower.includes("_bento_")) return "Bento";
  if (lower.includes("_plated_")) return "Plated";
  return "Sonstig";
}

interface DriveImageEntry { name: string; path: string; score: number; label: string; }

function scanDriveFolder(dir: string): DriveImageEntry[] {
  const results: DriveImageEntry[] = [];
  try {
    const entries: Dirent[] = readdirSync(dir, { withFileTypes: true });
    for (const e of entries) {
      const fullPath = join(dir, e.name);
      if (e.isDirectory()) {
        results.push(...scanDriveFolder(fullPath));
      } else if (/\.(jpe?g|png|webp)$/i.test(e.name)) {
        results.push({ name: e.name, path: fullPath, score: scoreDriveFile(e.name), label: imageLabelFromName(e.name) });
      }
    }
  } catch { /* Ordner nicht erreichbar */ }
  return results;
}

function mealFolderImagesPlugin(): Plugin {
  return {
    name: "meal-folder-images",
    configureServer(server: ViteDevServer) {
      server.middlewares.use("/api/meal-folder-images", (req: IncomingMessage, res: ServerResponse) => {
        if (req.method !== "GET") { res.statusCode = 405; res.end(); return; }
        const mealId = req.url?.replace(/^\//, "").split("?")[0].toUpperCase() ?? "";
        res.setHeader("Content-Type", "application/json");
        res.setHeader("Cache-Control", "no-store");
        if (!mealId || !existsSync(DRIVE_SOURCE_DIR)) { res.end(JSON.stringify([])); return; }
        try {
          const mealDirs = readdirSync(DRIVE_SOURCE_DIR, { withFileTypes: true })
            .filter((e: Dirent) => e.isDirectory() && folderMatchesMealId(e.name, mealId))
            .map((e: Dirent) => join(DRIVE_SOURCE_DIR, e.name));
          const allImages: DriveImageEntry[] = mealDirs.flatMap(scanDriveFolder);
          allImages.sort((a, b) => b.score - a.score);
          res.end(JSON.stringify(allImages.map(img => ({
            name: img.name,
            score: img.score,
            label: img.label,
            url: `/api/drive-image?p=${encodeURIComponent(img.path)}`,
          }))));
        } catch { res.end(JSON.stringify([])); }
      });
    },
  };
}

function driveImagePlugin(): Plugin {
  return {
    name: "drive-image",
    configureServer(server: ViteDevServer) {
      server.middlewares.use("/api/drive-image", (req: IncomingMessage, res: ServerResponse) => {
        if (req.method !== "GET") { res.statusCode = 405; res.end(); return; }
        const qs = req.url?.includes("?") ? req.url.slice(req.url.indexOf("?") + 1) : "";
        const p = new URLSearchParams(qs).get("p") ?? "";
        if (!p || !resolve(p).startsWith(DRIVE_SOURCE_DIR)) { res.statusCode = 403; res.end(); return; }
        try {
          const buf = readFileSync(p);
          const ext = extname(p).toLowerCase();
          const mime = ext === ".png" ? "image/png" : ext === ".webp" ? "image/webp" : "image/jpeg";
          res.setHeader("Content-Type", mime);
          res.setHeader("Cache-Control", "public, max-age=86400");
          res.end(buf);
        } catch { res.statusCode = 404; res.end(); }
      });
    },
  };
}

function saveMealImagePlugin(): Plugin {
  return {
    name: "save-meal-image",
    configureServer(server: ViteDevServer) {
      server.middlewares.use("/api/save-meal-image", (req: IncomingMessage, res: ServerResponse) => {
        if (req.method !== "GET") { res.statusCode = 405; res.end(); return; }
        res.setHeader("Content-Type", "application/json");
        res.setHeader("Cache-Control", "no-store");
        const qs = req.url?.includes("?") ? req.url.slice(req.url.indexOf("?") + 1) : "";
        const params = new URLSearchParams(qs);
        const mealId = (params.get("mealId") ?? "").toUpperCase().replace(/[^A-Z0-9]/g, "");
        const srcPath = params.get("p") ?? "";
        if (!mealId || !srcPath || !resolve(srcPath).startsWith(DRIVE_SOURCE_DIR)) {
          res.statusCode = 400;
          res.end(JSON.stringify({ error: "Ungültige Parameter" }));
          return;
        }
        try {
          const srcExt = extname(srcPath).toLowerCase() || ".jpg";
          const destDir = join(process.cwd(), "public", "data", "meal-images");
          const destPath = join(destDir, `${mealId}${srcExt}`);
          copyFileSync(srcPath, destPath);
          const localUrl = `/data/meal-images/${mealId}${srcExt}`;
          // Keep meal-catalog.json and data.json in sync so deployed version shows the image
          for (const jsonPath of ["public/data/meal-catalog.json", "public/data/data.json"]) {
            try {
              const full = join(process.cwd(), jsonPath);
              const parsed = JSON.parse(readFileSync(full, "utf8"));
              const catalog: Record<string, { mealId: string; photoUrl?: string; sheets?: object }> = parsed.mealCatalog ?? parsed;
              if (catalog[mealId]) catalog[mealId].photoUrl = localUrl;
              else catalog[mealId] = { mealId, photoUrl: localUrl, sheets: {} };
              const indent = jsonPath.includes("meal-catalog") ? 2 : 0;
              writeFileSync(full, JSON.stringify(parsed, null, indent), "utf8");
            } catch { /* non-fatal */ }
          }
          res.end(JSON.stringify({ url: localUrl }));
        } catch (err) {
          res.statusCode = 500;
          res.end(JSON.stringify({ error: String(err) }));
        }
      });
    },
  };
}

function mealImageListPlugin(): Plugin {
  return {
    name: "meal-image-list",
    configureServer(server: ViteDevServer) {
      server.middlewares.use("/api/meal-images", (req: IncomingMessage, res: ServerResponse) => {
        if (req.method !== "GET") { res.statusCode = 405; res.end(); return; }
        try {
          const dir = join(process.cwd(), "public", "data", "meal-images");
          const files = readdirSync(dir).filter((f: string) => /\.(jpe?g|png|webp|gif|avif)$/i.test(f));
          res.setHeader("Content-Type", "application/json");
          res.setHeader("Cache-Control", "no-store");
          res.end(JSON.stringify(files.sort()));
        } catch {
          res.statusCode = 500;
          res.end(JSON.stringify([]));
        }
      });
    },
  };
}

function deployPlugin(): Plugin {
  return {
    name: "deploy",
    configureServer(server: ViteDevServer) {
      server.middlewares.use("/api/deploy", (req: IncomingMessage, res: ServerResponse) => {
        if (req.method !== "POST") { res.statusCode = 405; res.end(); return; }
        res.setHeader("Content-Type", "text/plain; charset=utf-8");
        res.setHeader("Transfer-Encoding", "chunked");
        res.setHeader("Cache-Control", "no-store");
        const stripAnsi = (s: string) => stripVTControlCharacters(s);
        const child = spawn("cmd", ["/c", "npm run build && npx firebase deploy --only hosting"], {
          cwd: process.cwd(),
          shell: false,
          env: { ...process.env, FORCE_COLOR: "0" },
          windowsHide: true,
        });
        child.stdout?.on("data", (d: Buffer) => res.write(stripAnsi(d.toString())));
        child.stderr?.on("data", (d: Buffer) => res.write(stripAnsi(d.toString())));
        child.on("close", (code: number | null) => { res.write(`\n__DONE:${code ?? 1}__`); res.end(); });
        child.on("error", (err: Error) => { res.write(`\nFehler: ${err.message}\n__DONE:1__`); res.end(); });
      });
    },
  };
}

function startWmsServerPlugin(): Plugin {
  let wmsChild: ReturnType<typeof spawn> | null = null;
  return {
    name: "start-wms-server",
    configureServer(server: ViteDevServer) {
      server.middlewares.use("/api/start-wms-server", async (req: IncomingMessage, res: ServerResponse) => {
        if (req.method !== "POST") { res.statusCode = 405; res.end(); return; }
        res.setHeader("Content-Type", "text/plain; charset=utf-8");
        res.setHeader("Transfer-Encoding", "chunked");
        res.setHeader("Cache-Control", "no-store");

        if (await isPortOpen(3141)) {
          res.write("WMS-Server läuft bereits.\n__DONE:0__");
          res.end();
          return;
        }

        const stripAnsi = (s: string) => stripVTControlCharacters(s);

        if (wmsChild && !wmsChild.killed) wmsChild.kill();
        wmsChild = spawn("npx", ["tsx", "scripts/wms-local-server.ts"], {
          cwd: process.cwd(),
          shell: true,
          env: { ...process.env, FORCE_COLOR: "0" },
          windowsHide: true,
        });

        wmsChild.stdout?.on("data", (d: Buffer) => { if (!res.writableEnded) res.write(stripAnsi(d.toString())); });
        wmsChild.stderr?.on("data", (d: Buffer) => { if (!res.writableEnded) res.write(stripAnsi(d.toString())); });
        wmsChild.on("error", (err: Error) => {
          if (!res.writableEnded) { res.write(`\nFehler: ${err.message}\n__DONE:1__`); res.end(); }
        });

        let elapsed = 0;
        const poll = setInterval(async () => {
          elapsed += 500;
          if (await isPortOpen(3141)) {
            clearInterval(poll);
            if (!res.writableEnded) { res.write("\nWMS-Server bereit ✓\n__DONE:0__"); res.end(); }
          } else if (elapsed >= 30000) {
            clearInterval(poll);
            if (!res.writableEnded) { res.write("\nTimeout: Port 3141 nicht erreichbar.\n__DONE:1__"); res.end(); }
          }
        }, 500);

        server.httpServer?.once("close", () => {
          clearInterval(poll);
          if (wmsChild && !wmsChild.killed) wmsChild.kill();
        });
      });

      server.middlewares.use("/api/server-status", async (_req: IncomingMessage, res: ServerResponse) => {
        res.setHeader("Content-Type", "application/json");
        res.setHeader("Cache-Control", "no-store");
        const [wms, db] = await Promise.all([isPortOpen(3141), isPortOpen(3142)]);
        res.end(JSON.stringify({ wms, db }));
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
  plugins: [autoStartWmsPlugin(), autoStartLocalDbPlugin(), importLocalPlugin(), mealFolderImagesPlugin(), driveImagePlugin(), saveMealImagePlugin(), mealImageListPlugin(), deployPlugin(), startWmsServerPlugin(), noopRefreshRampUpPlugin(), react()],
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
      "/api/rack-boxfiles": {
        target: "http://127.0.0.1:5001",
        changeOrigin: true,
        rewrite: path => path.replace(/^\/api\/rack-boxfiles/, "/hellofresh-de-problem-solve/europe-west3/rackBoxfiles"),
      },
      "/api/rack-inputs": {
        target: "http://127.0.0.1:5001",
        changeOrigin: true,
        rewrite: path => path.replace(/^\/api\/rack-inputs/, "/hellofresh-de-problem-solve/europe-west3/rackInputs"),
      },
      "/api/local-db": {
        target: "http://127.0.0.1:3142",
        changeOrigin: true,
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
      "/api/wms-wo-detail": { target: "http://127.0.0.1:3141", changeOrigin: true, rewrite: (p: string) => p.replace(/^\/api/, "") },
      "/api/wms-plating-holding": { target: "http://127.0.0.1:3141", changeOrigin: true, rewrite: (p: string) => p.replace(/^\/api/, "") },
      "/api/wms-plating-history": { target: "http://127.0.0.1:3141", changeOrigin: true, rewrite: (p: string) => p.replace(/^\/api/, "") },
      "/api/redzone-plating-status": { target: "http://127.0.0.1:3141", changeOrigin: true, rewrite: (p: string) => p.replace(/^\/api/, "") },
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
