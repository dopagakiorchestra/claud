/**
 * ページ間のリンク。
 *
 * このアプリは HTML が2枚ある（コード進行 / ダンス動画）。行き先のファイル名を
 * ソースに直書きしないのは、`npm run build:single` が別のファイル名で書き出すため。
 * ビルド時に define で差し替えられるよう、定数を1か所に集めてある。
 */

import { encodeSongToHash } from "./state";
import type { Song } from "./music/song";

declare const __CHORD_PAGE__: string;
declare const __DANCE_PAGE__: string;

export const CHORD_PAGE: string = __CHORD_PAGE__;
export const DANCE_PAGE: string = __DANCE_PAGE__;

/**
 * 曲データを URL に載せたページリンク。
 *
 * localStorage 越しでも曲は引き継がれるが、リンクに載せておくと
 * 別のブラウザや共有されたリンクからでも同じ曲のまま行き来できる。
 */
export function pageUrl(page: string, song: Song): string {
  return `${page}#s=${encodeSongToHash(song)}`;
}
