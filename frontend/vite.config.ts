import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { VitePWA } from "vite-plugin-pwa";

export default defineConfig({
  plugins: [
    react(),
    VitePWA({
      registerType: "autoUpdate",
      includeAssets: ["icon.svg"],
      manifest: {
        name: "CHIMP-WATCH AI",
        short_name: "ChimpWatch",
        description: "Chimpanzee conservation and ecosystem early-warning platform",
        theme_color: "#17302A",
        background_color: "#F2F4EF",
        display: "standalone",
        start_url: "/",
        icons: [
          { src: "icon.svg", sizes: "any", type: "image/svg+xml", purpose: "any" },
          { src: "icon-192.png", sizes: "192x192", type: "image/png" },
          { src: "icon-512.png", sizes: "512x512", type: "image/png", purpose: "any maskable" },
        ],
      },
      workbox: {
        globPatterns: ["**/*.{js,css,html,svg,png,woff2}"],
        navigateFallbackDenylist: [/^\/api\//],
        runtimeCaching: [
          {
            urlPattern: ({ url }) => url.hostname.endsWith("tile.openstreetmap.org") || url.hostname.includes("arcgisonline"),
            handler: "CacheFirst",
            options: { cacheName: "map-tiles", expiration: { maxEntries: 3000, maxAgeSeconds: 60 * 60 * 24 * 30 } },
          },
          {
            urlPattern: ({ url }) => url.pathname === "/api/areas.geojson" || url.pathname === "/api/meta" || url.pathname === "/api/areas",
            handler: "NetworkFirst",
            options: { cacheName: "reference-data", networkTimeoutSeconds: 4 },
          },
        ],
      },
    }),
  ],
  server: { proxy: { "/api": "http://localhost:8000" } },
  preview: { proxy: { "/api": "http://localhost:8000" } },
  build: { chunkSizeWarningLimit: 900 },
});
