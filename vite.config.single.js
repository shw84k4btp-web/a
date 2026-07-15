// スタンドアロン単一HTML版のビルド設定。
// JS/CSS をすべて index.single.html に埋め込み、
// コピペや1ファイル配置だけで動く toilet-finder.html を生成する。
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { viteSingleFile } from 'vite-plugin-singlefile';

export default defineConfig({
  plugins: [react(), viteSingleFile()],
  build: {
    rollupOptions: { input: 'index.single.html' },
    outDir: 'dist-single',
    emptyOutDir: true,
  },
});
