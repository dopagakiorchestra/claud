/**
 * 定番コード進行のプリセット。
 *
 * 各コードは [主音からの半音数, クオリティID] で表す。キー非依存なので
 * どのキーを選んでも同じ響きの関係が保たれる。
 */

import { makeSlot, type ChordSlot } from "./song";

/** [主音からの半音数, クオリティID, 拍数?, 転回?] */
export type PresetChord = [offset: number, quality: string, beats?: number, inversion?: number];

export interface Preset {
  id: string;
  name: string;
  /** 使い所の説明。 */
  hint: string;
  /** 想定スケール（切り替え時にこのスケールへ合わせる）。 */
  scale: string;
  chords: PresetChord[];
}

export const PRESETS: Preset[] = [
  {
    id: "1564",
    name: "I–V–vi–IV（王道ポップ）",
    hint: "洋楽ポップスの超定番。明るく前向き。",
    scale: "major",
    chords: [
      [0, "maj"],
      [7, "maj"],
      [9, "min"],
      [5, "maj"],
    ],
  },
  {
    id: "canon",
    name: "カノン進行",
    hint: "パッヘルベルのカノン。壮大で感動的。",
    scale: "major",
    chords: [
      [0, "maj"],
      [7, "maj"],
      [9, "min"],
      [4, "min"],
      [5, "maj"],
      [0, "maj"],
      [5, "maj"],
      [7, "maj"],
    ],
  },
  {
    id: "royalroad",
    name: "王道進行（IVmaj7–V7–iii7–vi）",
    hint: "J-POPの黄金パターン。切なさと高揚感。",
    scale: "major",
    chords: [
      [5, "maj7"],
      [7, "7"],
      [4, "m7"],
      [9, "m7"],
    ],
  },
  {
    id: "komuro",
    name: "小室進行（vi–IV–V–I）",
    hint: "疾走感のあるダンスポップ。90年代J-POPの定番。",
    // 鳴る和音は同じでも、主音をどこに置くかで「何調の曲か」が変わる。
    // 名前どおり vi から始まって I に着地する形＝選んだキーがそのまま
    // 曲の中心になるように、メジャーの度数で持つ。
    scale: "major",
    chords: [
      [9, "min"],
      [5, "maj"],
      [7, "maj"],
      [0, "maj"],
    ],
  },
  {
    id: "koakuma",
    name: "小悪魔進行（IV–iii–vi–V）",
    hint: "ちょっと不安げで色っぽい響き。",
    scale: "major",
    chords: [
      [5, "maj7"],
      [4, "m7"],
      [9, "m7"],
      [7, "7"],
    ],
  },
  {
    id: "just2515",
    name: "Just Two-Five（ii–V–I）",
    hint: "ジャズの基本形。落ち着いた解決感。",
    scale: "major",
    chords: [
      [2, "m7"],
      [7, "7"],
      [0, "maj7", 8],
    ],
  },
  {
    id: "circle",
    name: "循環コード（I–vi–ii–V）",
    hint: "延々と回せる。ジャズ/歌謡曲の土台。",
    scale: "major",
    chords: [
      [0, "maj7"],
      [9, "m7"],
      [2, "m7"],
      [7, "7"],
    ],
  },
  {
    id: "blues12",
    name: "12小節ブルース",
    hint: "ブルース/ロックの原点。",
    scale: "mixolydian",
    chords: [
      [0, "7"],
      [0, "7"],
      [0, "7"],
      [0, "7"],
      [5, "7"],
      [5, "7"],
      [0, "7"],
      [0, "7"],
      [7, "7"],
      [5, "7"],
      [0, "7"],
      [7, "7"],
    ],
  },
  {
    id: "sad4536",
    name: "4536進行（IV–V–iii–vi）",
    hint: "「泣き」の定番。サビ前にも強い。",
    scale: "major",
    chords: [
      [5, "maj"],
      [7, "maj"],
      [4, "min"],
      [9, "min"],
    ],
  },
  {
    id: "descend",
    name: "下降ベース（I–V/VII–vi–I/V）",
    hint: "ベースが順に降りていく美しい進行。分数コード入り。",
    scale: "major",
    chords: [
      [0, "maj"],
      [7, "maj", 4, 1],
      [9, "min"],
      [0, "maj", 4, 2],
    ],
  },
  {
    id: "citypop",
    name: "シティポップ（IVmaj7–iii7–vim7–II7）",
    hint: "セカンダリードミナントでおしゃれに。",
    scale: "major",
    chords: [
      [5, "maj7"],
      [4, "m7"],
      [9, "m7"],
      [2, "7"],
    ],
  },
  {
    id: "andalusian",
    name: "アンダルシア終止（i–VII–VI–V）",
    hint: "フラメンコ風。哀愁と緊張感。",
    scale: "minor",
    chords: [
      [0, "min"],
      [10, "maj"],
      [8, "maj"],
      [7, "7"],
    ],
  },
  {
    id: "citylofi",
    name: "Lo-Fi（Imaj7–IVmaj7）",
    hint: "ゆるく漂う2コード。作業用BGMに。",
    scale: "major",
    chords: [
      [0, "maj9", 8],
      [5, "maj9", 8],
    ],
  },
  {
    id: "jpop6451",
    name: "6451進行（vi–IV–I–V）",
    hint: "感情的な立ち上がり。サビ頭に強い。",
    scale: "major",
    chords: [
      [9, "min"],
      [5, "maj"],
      [0, "maj"],
      [7, "maj"],
    ],
  },
];

/** プリセットを ChordSlot 列に展開する。 */
export function presetToSlots(preset: Preset, defaultBeats = 4): ChordSlot[] {
  return preset.chords.map(([offset, quality, beats, inversion]) => {
    const slot = makeSlot(offset, quality, beats ?? defaultBeats);
    if (inversion) slot.inversion = inversion;
    return slot;
  });
}
