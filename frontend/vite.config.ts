import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import tsConfigPaths from "vite-tsconfig-paths";
import { TanStackRouterVite } from "@tanstack/router-plugin/vite";

// ────────────────────────────────────────────────────────────────────────────
// SPA (client-only) build configuration.
// Output: dist/index.html + dist/assets/* — deployable as static files.
// ────────────────────────────────────────────────────────────────────────────
export default defineConfig({
  plugins: [
    TanStackRouterVite({
      routeFileIgnorePrefix: "-",
      // The generated route tree lives inside src/routes/ — tell the scanner
      // to skip it so it doesn't warn that it "does not export a Route".
      routeFileIgnorePattern: "routeTree.gen.ts",
    }),
    react(),
    tailwindcss(),
    tsConfigPaths(),
  ],
  build: {
    outDir: "dist",
    emptyOutDir: true,
  },
  server: {
    // Dev only: forward /api calls to the Express backend (port 7979,
    // matching backend PORT) so the httpOnly session cookie works
    // same-origin in the browser during development — exactly like Nginx
    // does in production.
    proxy: {
      "/api": {
        target: "http://localhost:7979",
        changeOrigin: true,
      },
    },
  },
});
