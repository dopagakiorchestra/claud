/**
 * コードの種類（クオリティ）定義と、構成音 ↔ コード名の相互変換。
 *
 * intervals は root からの半音数。root は必ず 0 を含む。
 */

import { mod12, pcName, prettyAccidentals } from "./notes";

export interface ChordQuality {
  /** データに保存される安定したID。 */
  id: string;
  /** コード名に付くサフィックス（root 名の後ろに付く文字列）。 */
  suffix: string;
  /** 日本語の説明（UIのツールチップ用）。 */
  label: string;
  /** root からの半音インターバル。 */
  intervals: number[];
  /** ダイアトニックの三和音/七の和音として自動命名の候補にするか。 */
  diatonic?: boolean;
}

export const QUALITIES: ChordQuality[] = [
  // --- 三和音 ---
  { id: "maj", suffix: "", label: "メジャー", intervals: [0, 4, 7], diatonic: true },
  { id: "min", suffix: "m", label: "マイナー", intervals: [0, 3, 7], diatonic: true },
  { id: "dim", suffix: "dim", label: "ディミニッシュ", intervals: [0, 3, 6], diatonic: true },
  { id: "aug", suffix: "aug", label: "オーギュメント", intervals: [0, 4, 8], diatonic: true },
  { id: "sus2", suffix: "sus2", label: "サスペンデッド2nd", intervals: [0, 2, 7] },
  { id: "sus4", suffix: "sus4", label: "サスペンデッド4th", intervals: [0, 5, 7] },
  { id: "5", suffix: "5", label: "パワーコード（5th）", intervals: [0, 7] },

  // --- 6th / add ---
  { id: "6", suffix: "6", label: "メジャー6th", intervals: [0, 4, 7, 9] },
  { id: "m6", suffix: "m6", label: "マイナー6th", intervals: [0, 3, 7, 9] },
  { id: "add9", suffix: "add9", label: "アド9th", intervals: [0, 4, 7, 14] },
  { id: "madd9", suffix: "m(add9)", label: "マイナー・アド9th", intervals: [0, 3, 7, 14] },

  // --- 七の和音 ---
  { id: "maj7", suffix: "maj7", label: "メジャーセブンス", intervals: [0, 4, 7, 11], diatonic: true },
  { id: "m7", suffix: "m7", label: "マイナーセブンス", intervals: [0, 3, 7, 10], diatonic: true },
  { id: "7", suffix: "7", label: "ドミナントセブンス", intervals: [0, 4, 7, 10], diatonic: true },
  { id: "m7b5", suffix: "m7b5", label: "ハーフディミニッシュ", intervals: [0, 3, 6, 10], diatonic: true },
  { id: "dim7", suffix: "dim7", label: "ディミニッシュセブンス", intervals: [0, 3, 6, 9], diatonic: true },
  { id: "mMaj7", suffix: "mMaj7", label: "マイナー・メジャーセブンス", intervals: [0, 3, 7, 11], diatonic: true },
  { id: "maj7#5", suffix: "maj7#5", label: "オーギュメント・メジャーセブンス", intervals: [0, 4, 8, 11], diatonic: true },
  { id: "7sus4", suffix: "7sus4", label: "セブンス・サスフォー", intervals: [0, 5, 7, 10] },
  { id: "aug7", suffix: "7#5", label: "オーギュメントセブンス", intervals: [0, 4, 8, 10] },
  { id: "7b5", suffix: "7b5", label: "セブンス・フラットファイブ", intervals: [0, 4, 6, 10] },

  // --- テンションつき（5thを省いた実用的なボイシング） ---
  { id: "maj9", suffix: "maj9", label: "メジャーナインス", intervals: [0, 4, 7, 11, 14] },
  { id: "m9", suffix: "m9", label: "マイナーナインス", intervals: [0, 3, 7, 10, 14] },
  { id: "9", suffix: "9", label: "ナインス", intervals: [0, 4, 7, 10, 14] },
  { id: "7b9", suffix: "7b9", label: "セブンス・フラットナインス", intervals: [0, 4, 7, 10, 13] },
  { id: "7#9", suffix: "7#9", label: "セブンス・シャープナインス", intervals: [0, 4, 7, 10, 15] },
  { id: "11", suffix: "11", label: "イレブンス", intervals: [0, 7, 10, 14, 17] },
  { id: "m11", suffix: "m11", label: "マイナーイレブンス", intervals: [0, 3, 7, 10, 17] },
  { id: "13", suffix: "13", label: "サーティーンス", intervals: [0, 4, 10, 14, 21] },
  { id: "maj13", suffix: "maj13", label: "メジャーサーティーンス", intervals: [0, 4, 11, 14, 21] },
  { id: "6/9", suffix: "6/9", label: "シックスナインス", intervals: [0, 4, 7, 9, 14] },

  // --- テンションを変化させたもの（ジャズでよく出る） ---
  // いずれも5度を省いている。5度は響きを決めないわりに場所を取るので、
  // 入れるとテンションが埋もれて狙いの色が出なくなる。
  {
    id: "7alt",
    suffix: "7alt",
    label: "オルタード（1,3,♭7,♭9,♭13）",
    intervals: [0, 4, 10, 13, 20],
  },
  {
    id: "maj9#11",
    suffix: "maj9(#11)",
    label: "メジャー9th シャープ11th",
    intervals: [0, 4, 11, 14, 18],
  },
  {
    id: "13b9",
    suffix: "13(b9)",
    label: "サーティーンス・フラットナインス",
    intervals: [0, 4, 10, 13, 21],
  },
  {
    id: "7#5#9",
    suffix: "7(#5#9)",
    label: "セブンス・シャープファイブ・シャープナインス",
    intervals: [0, 4, 8, 10, 15],
  },
];

const QUALITY_BY_ID = new Map(QUALITIES.map((q) => [q.id, q]));

export function getQuality(id: string): ChordQuality {
  const q = QUALITY_BY_ID.get(id);
  if (!q) throw new Error(`未知のコードクオリティ: ${id}`);
  return q;
}

export function hasQuality(id: string): boolean {
  return QUALITY_BY_ID.has(id);
}

/**
 * 構成音のインターバル集合からクオリティを逆引きする。
 * ダイアトニック導出（スケール音を積んだ結果の命名）に使う。
 * 完全一致が見つからない場合は null。
 */
export function findQualityByIntervals(intervals: number[]): ChordQuality | null {
  const key = normalizeIntervals(intervals);
  for (const q of QUALITIES) {
    if (!q.diatonic) continue;
    if (normalizeIntervals(q.intervals) === key) return q;
  }
  return null;
}

/** インターバル集合を「オクターブ内・重複なし・昇順」の文字列キーに正規化。 */
function normalizeIntervals(intervals: number[]): string {
  return [...new Set(intervals.map(mod12))].sort((a, b) => a - b).join(",");
}

/** コードの構成音のピッチクラス集合。 */
export function chordPitchClasses(rootPc: number, qualityId: string): number[] {
  return getQuality(qualityId).intervals.map((i) => mod12(rootPc + i));
}

/**
 * コード名を組み立てる。
 * bassPc に root 以外を渡すと "C/G" のような分数コード表記になる。
 */
export function chordName(
  rootPc: number,
  qualityId: string,
  useFlats = false,
  bassPc?: number,
): string {
  const q = getQuality(qualityId);
  let name = pcName(rootPc, useFlats) + q.suffix;
  if (bassPc !== undefined && mod12(bassPc) !== mod12(rootPc)) {
    name += `/${pcName(bassPc, useFlats)}`;
  }
  return name;
}

/** 表示用の綺麗なコード名（♯/♭ 記号つき）。 */
export function prettyChordName(
  rootPc: number,
  qualityId: string,
  useFlats = false,
  bassPc?: number,
): string {
  return prettyAccidentals(chordName(rootPc, qualityId, useFlats, bassPc));
}
