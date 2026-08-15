/**
 * プリセットのテスト。
 *
 * いちばん効くのは「名前に書いてある度数と、実際に出てくる度数が
 * 合っているか」。ここがずれると、選んだキーと違う調の曲になる。
 * 音は鳴るし警告も出ないので、突き合わせないと気づけない。
 */

import { describe, expect, it } from "vitest";

import { PRESETS, presetToSlots } from "../src/music/presets";
import { SCALES } from "../src/music/scales";
import { resolveChords } from "../src/music/song";
import { DEFAULT_SONG } from "../src/state";

/** 名前の括弧から度数表記を取り出す。無ければ null。 */
function romansFromName(name: string): string[] | null {
  const inner = /[（(]([^）)]+)[）)]/.exec(name)?.[1];
  if (!inner || !/[IiVv]/.test(inner)) return null;
  return inner.split(/[–—-]/).map((s) => s.trim());
}

/**
 * 度数表記から「何度か」だけを取り出す。
 * maj7 や m7 のような和音の種類、分数コードの下は落とす。
 */
function degreeOnly(roman: string): string {
  const head = roman.split("/")[0];
  return /^[♭♯b#]*[IiVv]+/.exec(head)?.[0] ?? head;
}

function romansOf(preset: (typeof PRESETS)[number]): string[] {
  const song = { ...DEFAULT_SONG, tonic: 0, scale: preset.scale, chords: presetToSlots(preset) };
  return resolveChords(song).map((c) => c.roman);
}

describe("プリセットの定義", () => {
  it("すべて id が重複していない", () => {
    const ids = PRESETS.map((p) => p.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it.each(PRESETS.map((p) => [p.id, p] as const))("%s のスケールが実在する", (_id, p) => {
    expect(SCALES.some((s) => s.id === p.scale)).toBe(true);
  });

  it.each(PRESETS.map((p) => [p.id, p] as const))("%s は和音が1つ以上ある", (_id, p) => {
    expect(p.chords.length).toBeGreaterThan(0);
  });

  it.each(PRESETS.map((p) => [p.id, p] as const))("%s の音程が範囲内", (_id, p) => {
    for (const [offset] of p.chords) {
      expect(offset).toBeGreaterThanOrEqual(0);
      expect(offset).toBeLessThanOrEqual(11);
    }
  });
});

describe("名前と中身が合っているか", () => {
  it.each(
    PRESETS.filter((p) => romansFromName(p.name)).map((p) => [p.id, p] as const),
  )("%s は名前どおりの度数で鳴る", (_id, p) => {
    const declared = romansFromName(p.name)!.map(degreeOnly);
    const actual = romansOf(p).map(degreeOnly);
    expect(actual).toEqual(declared);
  });

  it("小室進行はキーの I に着地する", () => {
    // vi から始まって I で終わる形。選んだキーがそのまま曲の中心になる。
    const komuro = PRESETS.find((p) => p.id === "komuro")!;
    const romans = romansOf(komuro).map(degreeOnly);
    expect(romans).toEqual(["vi", "IV", "V", "I"]);
  });

  it("小室進行はキー C で Am F G C になる", () => {
    const komuro = PRESETS.find((p) => p.id === "komuro")!;
    const song = { ...DEFAULT_SONG, tonic: 0, scale: komuro.scale, chords: presetToSlots(komuro) };
    expect(resolveChords(song).map((c) => c.name)).toEqual(["Am", "F", "G", "C"]);
  });
});

describe("キーを変えても関係が保たれる", () => {
  it.each(PRESETS.map((p) => [p.id, p] as const))("%s はどのキーでも度数が変わらない", (_id, p) => {
    const base = romansOf(p);
    for (const tonic of [2, 5, 7, 9, 11]) {
      const song = { ...DEFAULT_SONG, tonic, scale: p.scale, chords: presetToSlots(p) };
      expect(resolveChords(song).map((c) => c.roman)).toEqual(base);
    }
  });

  it.each(PRESETS.map((p) => [p.id, p] as const))("%s は移調すると実音がずれる", (_id, p) => {
    const at = (tonic: number) => {
      const song = { ...DEFAULT_SONG, tonic, scale: p.scale, chords: presetToSlots(p) };
      return resolveChords(song).map((c) => c.rootPc);
    };
    const c = at(0);
    const d = at(2);
    for (let i = 0; i < c.length; i++) expect((d[i] - c[i] + 12) % 12).toBe(2);
  });
});

describe("拍数", () => {
  it.each(PRESETS.map((p) => [p.id, p] as const))("%s の拍数が正の値になる", (_id, p) => {
    for (const slot of presetToSlots(p, 4)) {
      expect(slot.beats).toBeGreaterThan(0);
    }
  });

  it("拍子を渡すとその長さになる", () => {
    const p = PRESETS[0];
    expect(presetToSlots(p, 3).every((s) => s.beats === 3)).toBe(true);
  });
});
