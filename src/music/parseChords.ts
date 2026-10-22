/**
 * コード名の文字列を進行に変換する。
 *
 * 外から持ってきた進行をそのまま貼れるようにするためのもの。
 * 書き方は人によって揺れるので、よく使われる表記はひととおり受ける。
 *
 *   Fm11 | B7alt | Emaj9(#11) | A13(b9)
 *   Dm7 G7 | Cmaj7        ← 1小節に2つ書けば半分ずつになる
 *   C | Am | F | G
 *
 * 進行は「主音からの距離」で持つので、ここで今のキーとの差に直す。
 * あとからキーを変えれば全体が移調される。
 */

import { getQuality, hasQuality } from "./chords";
import { mod12, nameToPc } from "./notes";
import { makeSlot, type ChordSlot } from "./song";

/** 小節の区切り。縦棒と改行はどちらも区切りとして扱う。 */
const BAR_SEPARATOR = /[|｜\n\r]+/;
/** 小節の中のコードの区切り。空白と読点。 */
const CHORD_SEPARATOR = /[\s,、，]+/;

export interface ParsedChord {
  /** 入力された文字列そのまま。 */
  text: string;
  /** 読み取れた場合のコード。読み取れなければ null。 */
  slot: ChordSlot | null;
  /** 読み取れなかった理由。 */
  reason?: string;
}

export interface ParseResult {
  chords: ParsedChord[];
  /** 読み取れた数。 */
  ok: number;
  /** 読み取れなかった数。 */
  failed: number;
}

/**
 * 表記ゆれを、アプリの持っているコードの種類に寄せる。
 *
 * 左が入力（記号と括弧を落として小文字にしたもの）、右が種類のID。
 * ここに無い書き方は読み取れないものとして扱う。黙って別のコードに
 * してしまうより、読めなかったと伝えたほうがよい。
 */
const SUFFIX_ALIASES: Record<string, string> = {
  // 三和音
  "": "maj",
  maj: "maj",
  major: "maj",
  m: "min",
  mi: "min",
  min: "min",
  minor: "min",
  "-": "min",
  dim: "dim",
  o: "dim",
  aug: "aug",
  "+": "aug",
  "#5": "aug",
  sus: "sus4",
  sus2: "sus2",
  sus4: "sus4",
  "5": "5",

  // 6th / add
  "6": "6",
  m6: "m6",
  min6: "m6",
  "-6": "m6",
  add9: "add9",
  "2": "add9",
  madd9: "madd9",
  "madd 9": "madd9",
  minadd9: "madd9",

  // 7th
  maj7: "maj7",
  ma7: "maj7",
  major7: "maj7",
  m7: "m7",
  mi7: "m7",
  min7: "m7",
  "-7": "m7",
  "7": "7",
  dom7: "7",
  m7b5: "m7b5",
  min7b5: "m7b5",
  "m7-5": "m7b5",
  halfdim: "m7b5",
  dim7: "dim7",
  o7: "dim7",
  mmaj7: "mMaj7",
  mma7: "mMaj7",
  minmaj7: "mMaj7",
  "maj7#5": "maj7#5",
  "maj7+5": "maj7#5",
  "7sus4": "7sus4",
  "7sus": "7sus4",
  "7#5": "aug7",
  aug7: "aug7",
  "7+5": "aug7",
  "7b5": "7b5",
  "7-5": "7b5",

  // 9th 以上
  maj9: "maj9",
  ma9: "maj9",
  m9: "m9",
  min9: "m9",
  "-9": "m9",
  "9": "9",
  "7b9": "7b9",
  "7-9": "7b9",
  "7#9": "7#9",
  "7+9": "7#9",
  "11": "11",
  m11: "m11",
  min11: "m11",
  "-11": "m11",
  "13": "13",
  maj13: "maj13",
  "69": "6/9",
  "6/9": "6/9",

  // 変化させたテンション
  alt: "7alt",
  "7alt": "7alt",
  "7altered": "7alt",
  "maj9#11": "maj9#11",
  "maj7#11": "maj9#11",
  "ma9#11": "maj9#11",
  "13b9": "13b9",
  "13-9": "13b9",
  "7#5#9": "7#5#9",
  "7#9#5": "7#5#9",
  "7+5+9": "7#5#9",
};

/**
 * 読み取り用に表記をそろえる。
 * 括弧と空白を落とし、記号を半角にして、小文字にする。
 */
function normalizeSuffix(raw: string): string {
  return raw
    // 大文字の M はメジャー、小文字の m はマイナー。ここだけは
    // 小文字にそろえる前に片づける。Maj / Ma / Mi の途中の M は触らない。
    .replace(/M(?![aAiI])/g, "maj")
    .replace(/[()（）]/g, "")
    .replace(/[\s]/g, "")
    .replace(/[Δ△]/g, "maj")
    .replace(/[øØ]/g, "m7b5")
    .replace(/[°˚]/g, "dim")
    .replace(/[♯＃]/g, "#")
    .replace(/[♭]/g, "b")
    .replace(/[－−—–ー]/g, "-")
    .replace(/[＋]/g, "+")
    .toLowerCase();
}

/** コード名1つを読み取る。読めなければ null。 */
export function parseChordName(
  text: string,
  tonic: number,
  beats: number,
): ParsedChord {
  const trimmed = text.trim();
  if (!trimmed) return { text, slot: null, reason: "空" };

  // 分数コード（G/B など）。上の和音だけを使い、下の音は転回で近づける。
  // ただし 6/9 のように分数に見えて分数でない書き方があるので、
  // 斜線の右が音名のときだけ分数コードとして扱う。
  let head = trimmed;
  let bassPc: number | null = null;
  const slash = trimmed.lastIndexOf("/");
  if (slash > 0) {
    const maybeBass = nameToPc(trimmed.slice(slash + 1).trim());
    if (maybeBass !== null) {
      head = trimmed.slice(0, slash);
      bassPc = maybeBass;
    }
  }

  const m = /^([A-Ga-g])([#♯b♭＃]?)(.*)$/.exec(head.trim());
  if (!m) return { text, slot: null, reason: "音名で始まっていない" };

  const rootPc = nameToPc(m[1] + m[2]);
  if (rootPc === null) return { text, slot: null, reason: "音名が読めない" };

  const suffix = normalizeSuffix(m[3]);
  const qualityId = SUFFIX_ALIASES[suffix];
  if (!qualityId || !hasQuality(qualityId)) {
    return { text, slot: null, reason: `「${m[3] || "(なし)"}」が分からない` };
  }

  const slot = makeSlot(mod12(rootPc - tonic), qualityId, beats);
  if (bassPc !== null) {
    const inv = inversionForBass(qualityId, rootPc, bassPc);
    if (inv > 0) slot.inversion = inv;
  }
  return { text, slot };
}

/**
 * 指定の音が一番下に来る転回形を探す。
 * 構成音に無ければ 0（そのまま）を返す。
 */
function inversionForBass(qualityId: string, rootPc: number, bassPc: number): number {
  const intervals = getQuality(qualityId).intervals;
  for (let i = 0; i < intervals.length; i++) {
    if (mod12(rootPc + intervals[i]) === mod12(bassPc)) return i;
  }
  return 0;
}

/**
 * 進行全体を読み取る。
 *
 * 縦棒と改行で小節を区切り、1小節に複数書かれていれば、その小節を
 * 等分する。「Dm7 G7 | Cmaj7」なら Dm7 と G7 が2拍ずつになる。
 */
export function parseProgression(
  text: string,
  tonic: number,
  beatsPerBar: number,
): ParseResult {
  const chords: ParsedChord[] = [];

  for (const bar of text.split(BAR_SEPARATOR)) {
    const tokens = bar.split(CHORD_SEPARATOR).filter((t) => t.trim() !== "");
    if (tokens.length === 0) continue;
    // 小節を等分する。細かく割りすぎないよう下限を置く。
    const beats = Math.max(0.5, beatsPerBar / tokens.length);
    for (const token of tokens) chords.push(parseChordName(token, tonic, beats));
  }

  return {
    chords,
    ok: chords.filter((c) => c.slot !== null).length,
    failed: chords.filter((c) => c.slot === null).length,
  };
}
