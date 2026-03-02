import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      "/api": {
        target: process.env.WORKER_URL || "https://draw-guess-worker.deng19940906.workers.dev",
        ws: true,
        changeOrigin: true,
      },
    },
  },
});
