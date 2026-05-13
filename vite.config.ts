import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
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
    },
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
