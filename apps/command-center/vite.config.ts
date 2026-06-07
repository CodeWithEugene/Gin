import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    port: 5180,
    proxy: {
      // Dev: proxy the gateway WS so the client can always use same-origin /ws.
      "/ws": { target: "ws://127.0.0.1:18789", ws: true },
      "/health": { target: "http://127.0.0.1:18789" },
    },
  },
  build: { outDir: "dist", emptyOutDir: true },
  test: { environment: "node", include: ["src/**/*.test.ts"] },
});
