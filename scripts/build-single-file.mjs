/**
 * 各ページを、それぞれ1枚の HTML ファイルにまとめる。
 *
 * CSS と JS をインライン化するので、外部ファイルを一切読み込まない。
 * ダブルクリックでブラウザで開けるし、どんな静的ホスティングにも置ける。
 *
 *   node scripts/build-single-file.mjs
 *   → dist-single/chord-progression-studio.html
 *     dist-single/dance-studio.html
 *
 * 通常の `npm run build` は2ページを1回でビルドするため、共通部分が別チャンクに
 * 切り出されて JS が1ファイルにならない。ここではページごとに独立したビルドを
 * 走らせて、それぞれ1つの JS にまとめている。
 *
 * ページ間リンクの行き先も、ここでの出力ファイル名に合わせて差し替える。
 * そうしないと、単体で配ったときにリンクが 404 になる。
 */

import { mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { build } from "vite";
import react from "@vitejs/plugin-react";

const OUT_DIR = "dist-single";
const TMP_DIR = ".tmp-single";

const PAGES = [
  {
    entry: "index.html",
    out: "chord-progression-studio.html",
    title: "Chord Progression Studio — コード進行メーカー",
    description: "コード進行を作って、その場で試聴して、MP3としてダウンロードできるアプリ。",
  },
  {
    entry: "dance.html",
    out: "dance-studio.html",
    title: "ダンス動画 — Chord Progression Studio",
    description:
      "コード進行に合わせた振り付けを組み立てて、マネキンが踊る動画を書き出せるアプリ。",
  },
];

/** インライン化後のリンク先。定数の差し替えに使う。 */
const LINK_TARGETS = {
  __CHORD_PAGE__: JSON.stringify(PAGES[0].out),
  __DANCE_PAGE__: JSON.stringify(PAGES[1].out),
};

/**
 * インライン化した JS を壊さないための処理。
 *
 * - `</script` があると HTML パーサが script 要素を終わらせてしまうので分割する。
 *   JS の文字列リテラルとしては `<\/script` と等価なので意味は変わらない。
 * - sourceMappingURL は参照先の .map を同梱しないため、404 になる前に消す。
 */
function inlineSafeJs(code) {
  return code
    .replace(/<\/script/gi, "<\\/script")
    .replace(/^\/\/# sourceMappingURL=.*$/gm, "")
    .trimEnd();
}

/** CSS 内の `</style` も同様に無効化しておく。 */
function inlineSafeCss(code) {
  return code.replace(/<\/style/gi, "<\\/style").trimEnd();
}

function readSingleAsset(dir, extension) {
  const assets = join(dir, "assets");
  const hits = readdirSync(assets).filter((f) => f.endsWith(extension));
  if (hits.length === 0) throw new Error(`${assets} に ${extension} が見つかりません。`);
  if (hits.length > 1) {
    // 1ページぶんのはずなのに分かれている＝インライン化できない状態
    throw new Error(
      `${assets} の ${extension} が ${hits.length} 個あります。` +
        `1枚にまとめるには1つでなければなりません（${hits.join(", ")}）。`,
    );
  }
  return readFileSync(join(assets, hits[0]), "utf8");
}

const kb = (n) => `${(n / 1024).toFixed(1)} kB`;

mkdirSync(OUT_DIR, { recursive: true });

for (const page of PAGES) {
  const outDir = join(TMP_DIR, page.entry.replace(".html", ""));

  await build({
    // vite.config.ts は2ページ同時ビルドの設定なので、ここでは使わずに組み直す
    configFile: false,
    root: process.cwd(),
    base: "./",
    plugins: [react()],
    logLevel: "warn",
    define: LINK_TARGETS,
    build: {
      outDir,
      emptyOutDir: true,
      sourcemap: false,
      rollupOptions: { input: page.entry },
    },
  });

  const css = inlineSafeCss(readSingleAsset(outDir, ".css"));
  const js = inlineSafeJs(readSingleAsset(outDir, ".js"));

  const html = `<!doctype html>
<html lang="ja">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>${page.title}</title>
    <meta name="description" content="${page.description}" />
    <style>
${css}
    </style>
  </head>
  <body>
    <div id="root"></div>
    <script type="module">
${js}
    </script>
  </body>
</html>
`;

  const outPath = join(OUT_DIR, page.out);
  writeFileSync(outPath, html, "utf8");
  console.log(`${outPath} を書き出しました（${kb(Buffer.byteLength(html))}）`);
  console.log(`  CSS ${kb(Buffer.byteLength(css))} / JS ${kb(Buffer.byteLength(js))} をインライン化`);
}

rmSync(TMP_DIR, { recursive: true, force: true });
console.log("2枚とも同じフォルダに置けば、ページ間のリンクもそのまま動きます。");
