import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  // 相対パスで出力しておくと GitHub Pages などサブディレクトリ配信でもそのまま動く
  base: "./",
  /**
   * ページ間リンクの行き先。
   * `npm run build:single` は別のファイル名で書き出すので、そちらでは
   * 同じ定数に違う値を差し込む（scripts/build-single-file.mjs を参照）。
   */
  define: {
    __CHORD_PAGE__: JSON.stringify("index.html"),
    __DANCE_PAGE__: JSON.stringify("dance.html"),
  },
  build: {
    outDir: "dist",
    sourcemap: true,
    rollupOptions: {
      // HTML が2枚あるので、それぞれを入口として指定する
      input: {
        main: "index.html",
        dance: "dance.html",
      },
    },
  },
});
