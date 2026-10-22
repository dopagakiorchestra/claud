/**
 * コード名の読み取りのテスト。
 *
 * いちばん怖いのは「読めない」ではなく「別のコードとして読めてしまう」こと。
 * 音は鳴るので気づけない。大文字小文字の取り違えを中心に確かめる。
 */

import { describe, expect, it } from "vitest";

import { getQuality } from "../src/music/chords";
import { parseChordName, parseProgression } from "../src/music/parseChords";
import { resolveChords } from "../src/music/song";
import { DEFAULT_SONG } from "../src/state";

/** キー C として読み、種類のIDを返す。 */
const q = (text: string) => parseChordName(text, 0, 4).slot?.quality ?? null;
/** キー C として読み、主音からの距離を返す。 */
const off = (text: string) => parseChordName(text, 0, 4).slot?.offset ?? null;

describe("報告された進行", () => {
  const TEXT = "Fm11 | B7alt | Emaj9(#11) | A13(b9) | Dm9 | G7(#5#9) | Cm11 | C7alt";

  it("8つすべて読み取れる", () => {
    const r = parseProgression(TEXT, 0, 4);
    expect(r.ok).toBe(8);
    expect(r.failed).toBe(0);
  });

  it("読み取った進行が、入力と同じ名前で表示される", () => {
    const r = parseProgression(TEXT, 0, 4);
    const song = { ...DEFAULT_SONG, tonic: 0, chords: r.chords.map((c) => c.slot!) };
    expect(resolveChords(song).map((c) => c.name)).toEqual([
      "Fm11",
      "B7alt",
      "Emaj9(♯11)",
      "A13(♭9)",
      "Dm9",
      "G7(♯5♯9)",
      "Cm11",
      "C7alt",
    ]);
  });

  it("どのコードもちゃんと音が出る", () => {
    const r = parseProgression(TEXT, 0, 4);
    const song = { ...DEFAULT_SONG, tonic: 0, chords: r.chords.map((c) => c.slot!) };
    for (const c of resolveChords(song)) {
      expect(c.notes.length).toBeGreaterThanOrEqual(3);
      expect(new Set(c.notes).size).toBe(c.notes.length);
    }
  });
});

describe("大文字と小文字を取り違えない", () => {
  it("M はメジャー、m はマイナー", () => {
    expect(q("AbM7")).toBe("maj7");
    expect(q("Abm7")).toBe("m7");
    expect(q("CM9")).toBe("maj9");
    expect(q("Cm9")).toBe("m9");
    expect(q("CM")).toBe("maj");
    expect(q("Cm")).toBe("min");
    expect(q("CM13")).toBe("maj13");
  });

  it("Maj / Ma / Mi も正しく読む", () => {
    expect(q("CMaj7")).toBe("maj7");
    expect(q("CMa7")).toBe("maj7");
    expect(q("CMi7")).toBe("m7");
    expect(q("CmMaj7")).toBe("mMaj7");
  });
});

describe("よくある別表記", () => {
  it.each([
    ["C-7", "m7"],
    ["C-9", "m9"],
    ["Cmin7", "m7"],
    ["CΔ7", "maj7"],
    ["C△7", "maj7"],
    ["Cø", "m7b5"],
    ["Cm7-5", "m7b5"],
    ["C°7", "dim7"],
    ["Co7", "dim7"],
    ["C+", "aug"],
    ["C7+5", "aug7"],
    ["Calt", "7alt"],
    ["C7alt", "7alt"],
    ["C7(#9#5)", "7#5#9"],
    ["C13(b9)", "13b9"],
    ["Cmaj9(#11)", "maj9#11"],
    ["C7sus", "7sus4"],
    ["C69", "6/9"],
  ])("%s を %s として読む", (text, expected) => {
    expect(q(text)).toBe(expected);
  });

  it("全角の記号も受ける", () => {
    expect(q("Cmaj9（＃11）")).toBe("maj9#11");
    expect(q("C7（♯5♯9）")).toBe("7#5#9");
  });
});

describe("音名", () => {
  it("♯ と ♭ を読む", () => {
    expect(off("C")).toBe(0);
    expect(off("C#")).toBe(1);
    expect(off("Db")).toBe(1);
    expect(off("C♯")).toBe(1);
    expect(off("D♭")).toBe(1);
    expect(off("B")).toBe(11);
    expect(off("Bb")).toBe(10);
  });

  it("キーからの距離として記録される", () => {
    // キー D（2）から見た G は 5 つ上
    expect(parseChordName("G", 2, 4).slot?.offset).toBe(5);
    // キーをまたいで下に回り込む場合
    expect(parseChordName("C", 2, 4).slot?.offset).toBe(10);
  });
});

describe("分数コード", () => {
  it("下の音が構成音なら転回形にする", () => {
    const slot = parseChordName("G/B", 0, 4).slot!;
    expect(slot.offset).toBe(7);
    expect(slot.quality).toBe("maj");
    expect(slot.inversion).toBe(1);
  });

  it("下の音が構成音でなければ、そのまま鳴らす", () => {
    const slot = parseChordName("C/F#", 0, 4).slot!;
    expect(slot.offset).toBe(0);
    expect(slot.inversion ?? 0).toBe(0);
  });

  it("6/9 を分数コードと間違えない", () => {
    expect(q("C6/9")).toBe("6/9");
  });
});

describe("小節の区切りと長さ", () => {
  it("縦棒で区切る", () => {
    const r = parseProgression("C | F | G", 0, 4);
    expect(r.ok).toBe(3);
    expect(r.chords.every((c) => c.slot?.beats === 4)).toBe(true);
  });

  it("改行でも区切る", () => {
    expect(parseProgression("C\nF\nG", 0, 4).ok).toBe(3);
  });

  it("1小節に2つ書けば半分ずつになる", () => {
    const r = parseProgression("Dm7 G7 | Cmaj7", 0, 4);
    expect(r.chords.map((c) => c.slot?.beats)).toEqual([2, 2, 4]);
  });

  it("1小節に4つでも割り切れる", () => {
    expect(parseProgression("C D E F", 0, 4).chords.every((c) => c.slot?.beats === 1)).toBe(true);
  });

  it("細かく割りすぎない（下限がある）", () => {
    const r = parseProgression("C D E F G A B C D E", 0, 4);
    for (const c of r.chords) expect(c.slot!.beats).toBeGreaterThanOrEqual(0.5);
  });

  it("拍子に合わせて割る", () => {
    expect(parseProgression("C F", 0, 3).chords.map((c) => c.slot?.beats)).toEqual([1.5, 1.5]);
  });
});

describe("読めないものは読めないと言う", () => {
  it("知らない書き方は黙って別のコードにしない", () => {
    const r = parseChordName("Cxyz", 0, 4);
    expect(r.slot).toBeNull();
    expect(r.reason).toContain("xyz");
  });

  it("音名で始まっていなければ読まない", () => {
    expect(parseChordName("Hm7", 0, 4).slot).toBeNull();
    expect(parseChordName("どれみ", 0, 4).slot).toBeNull();
  });

  it("読めたものと読めないものが混ざっても、読めたぶんは残る", () => {
    const r = parseProgression("C | ??? | G", 0, 4);
    expect(r.ok).toBe(2);
    expect(r.failed).toBe(1);
  });

  it("空の入力なら何も出ない", () => {
    const r = parseProgression("   \n  |  ", 0, 4);
    expect(r.chords).toHaveLength(0);
    expect(r.ok).toBe(0);
  });
});

describe("追加したコードの中身", () => {
  it.each([
    ["7alt", [0, 4, 10, 13, 20]],
    ["maj9#11", [0, 4, 11, 14, 18]],
    ["13b9", [0, 4, 10, 13, 21]],
    ["7#5#9", [0, 4, 8, 10, 15]],
  ])("%s の構成音", (id, intervals) => {
    expect(getQuality(id).intervals).toEqual(intervals);
  });

  it("どれも3度と♭7（またはメジャー7th）を持っている", () => {
    for (const id of ["7alt", "13b9", "7#5#9"]) {
      const iv = getQuality(id).intervals;
      expect(iv).toContain(4); // 長3度
      expect(iv).toContain(10); // ♭7
    }
    expect(getQuality("maj9#11").intervals).toContain(11);
  });
});
