import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [
    react(),
    // SPA fallback: rewrite /123456 style paths to index.html in dev
    {
      name: "spa-fallback",
      configureServer(server) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        server.middlewares.use(((req: any, _res: any, next: any) => {
          if (req.url && /^\/\d{6}(\?.*)?$/.test(req.url)) {
            req.url = "/";
          }
          next();
        }) as any);
      },
    },
  ],
});
