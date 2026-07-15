import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { VitePWA } from 'vite-plugin-pwa';

export default defineConfig({
  plugins: [
    react(),
    VitePWA({
      registerType: 'autoUpdate',
      includeAssets: ['icons/apple-touch-icon.png'],
      manifest: {
        name: 'トイレファインダー',
        short_name: 'トイレ',
        description: '現在地から最寄りのトイレを検索し、徒歩ルートを案内するアプリ',
        lang: 'ja',
        display: 'standalone',
        orientation: 'portrait',
        theme_color: '#1e40af',
        background_color: '#1e40af',
        start_url: '/',
        icons: [
          { src: '/icons/icon-192.png', sizes: '192x192', type: 'image/png' },
          { src: '/icons/icon-512.png', sizes: '512x512', type: 'image/png' },
          {
            src: '/icons/icon-512-maskable.png',
            sizes: '512x512',
            type: 'image/png',
            purpose: 'maskable',
          },
        ],
      },
      workbox: {
        // アプリ本体 (シェル) をキャッシュしてオフラインでも起動できるようにする。
        // 地図タイルや API は鮮度が重要なのでネットワーク優先で軽くキャッシュ。
        globPatterns: ['**/*.{js,css,html,png,svg}'],
        runtimeCaching: [
          {
            urlPattern: /^https:\/\/[abcd]\.basemaps\.cartocdn\.com\/.*/,
            handler: 'CacheFirst',
            options: {
              cacheName: 'map-tiles',
              expiration: { maxEntries: 300, maxAgeSeconds: 60 * 60 * 24 * 7 },
              cacheableResponse: { statuses: [0, 200] },
            },
          },
        ],
      },
    }),
  ],
});
