import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    open: true,
    proxy: {
      "/api/wms-live": {
        target: "http://127.0.0.1:5001/hellofresh-de-problem-solve/europe-west3/wmsLive",
        changeOrigin: true,
        rewrite: () => "",
      },
      "/api/refresh-ramp-up": {
        target: "http://127.0.0.1:5001/hellofresh-de-problem-solve/europe-west3/refreshRampUp",
        changeOrigin: true,
        rewrite: () => "",
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
