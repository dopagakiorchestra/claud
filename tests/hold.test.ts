/**
 * 伸ばしと打ち直しのテスト。
 *
 * ここでいちばん大事なのは、昔保存した曲の響きが変わらないこと。
 * 記録方式を変えたので、変換を間違えると、伸ばしていた音が全部
 * 連打に化ける。音は鳴るので気づきにくい。
 */

import { describe, expect, it } from "vitest";

import {
  HOLD,
  melodyToNotes,
  rescaleSteps,
  resolveSteps,
  hasMelody,
  usedOffsets,
  type Step,
} from "../src/music/melody";
import { normalizeSong } from "../src/state";

describe("伸ばしの解決", () => {
  it("伸ばしの印は直前の音を引き継ぐ", () => {
    expect(resolveSteps([5, HOLD, HOLD])).toEqual([
      { offset: 5, held: false },
      { offset: 5, held: true },
      { offset: 5, held: true },
    ]);
  });

  it("休符で伸ばしが切れる", () => {
    expect(resolveSteps([5, null, HOLD]).map((r) => r.offset)).toEqual([5, null, null]);
  });

  it("先頭の伸ばしは休符になる", () => {
    expect(resolveSteps([HOLD, 3]).map((r) => r.offset)).toEqual([null, 3]);
    expect(resolveSteps([HOLD, 3])[0].held).toBe(false);
  });

  it("同じ高さが隣り合っても、それぞれ別の音として立ち上がる", () => {
    expect(resolveSteps([2, 2]).map((r) => r.held)).toEqual([false, false]);
  });
});

describe("連打できること（報告された不具合）", () => {
  it("16分で同じ音を2つ並べると2回鳴る", () => {
    const notes = melodyToNotes([0, 0, null, null], 0, 4, 0);
    expect(notes).toHaveLength(2);
    expect(notes[0].midi).toBe(notes[1].midi);
    expect(notes.map((n) => n.start)).toEqual([0, 0.25]);
  });

  it("16分で同じ音を4つ並べると4回鳴る", () => {
    expect(melodyToNotes([7, 7, 7, 7], 0, 4, 0)).toHaveLength(4);
  });

  it("伸ばしたいときは1つの音のまま", () => {
    const notes = melodyToNotes([7, HOLD, HOLD, HOLD], 0, 4, 0);
    expect(notes).toHaveLength(1);
    expect(notes[0].dur).toBeCloseTo(1 * 0.98, 6);
  });

  it("連打と伸ばしを混ぜられる", () => {
    // 伸ばした音 → 打ち直し → 伸ばし
    const notes = melodyToNotes([0, HOLD, 0, HOLD], 0, 4, 0);
    expect(notes).toHaveLength(2);
    expect(notes.map((n) => n.start)).toEqual([0, 0.5]);
    for (const n of notes) expect(n.dur).toBeCloseTo(0.5 * 0.98, 6);
  });
});

describe("古い保存データの読み込み", () => {
  /** 旧方式（同じ高さの連続＝1つの長い音）で保存された曲。 */
  const oldSong = { melody: [4, 4, 4, null, 7, 7], melodyStepsPerBeat: 4 };

  it("伸ばしていた音は伸ばしたまま読み込まれる", () => {
    const song = normalizeSong(oldSong);
    expect(song.melody).toEqual([4, HOLD, HOLD, null, 7, HOLD]);
  });

  it("響きが変わらない", () => {
    const song = normalizeSong(oldSong);
    const notes = melodyToNotes(song.melody, 0, 4, 0);
    // 旧方式で鳴っていたのは「3ステップの音」と「2ステップの音」の2つ
    expect(notes).toHaveLength(2);
    expect(notes[0].dur).toBeCloseTo(0.75 * 0.98, 6);
    expect(notes[1].dur).toBeCloseTo(0.5 * 0.98, 6);
  });

  it("新しい方式のデータは変換しない", () => {
    const song = normalizeSong({ melody: [4, 4, HOLD], melodyFormat: 2 });
    // 変換されると [4, HOLD, HOLD] になってしまう
    expect(song.melody).toEqual([4, 4, HOLD]);
    expect(melodyToNotes(song.melody, 0, 4, 0)).toHaveLength(2);
  });

  it("読み込んだデータには新しい方式の印が付く", () => {
    expect(normalizeSong(oldSong).melodyFormat).toBe(2);
  });

  it("壊れた値が混ざっていても落ちない", () => {
    const song = normalizeSong({ melody: [HOLD, "x", 999, 4, HOLD] });
    expect(song.melody).toHaveLength(5);
    expect(() => melodyToNotes(song.melody, 0, 4, 0)).not.toThrow();
  });
});

describe("伸ばしの印の扱い", () => {
  it("伸ばしだけでは音があるとみなさない", () => {
    expect(hasMelody([HOLD, HOLD])).toBe(false);
    expect(hasMelody([HOLD, 3])).toBe(true);
  });

  it("使われている音に伸ばしの印は入らない", () => {
    expect(usedOffsets([4, HOLD, 7, HOLD]).sort((a, b) => a - b)).toEqual([4, 7]);
  });
});

describe("細かさを変えたとき", () => {
  it("8分の伸ばしが16分でも伸ばしのまま残る", () => {
    // 8分で「2ステップ伸ばした音」→ 16分では4ステップぶん
    const to = rescaleSteps([5, HOLD], 2, 4, 8);
    expect(to.slice(0, 4)).toEqual([5, HOLD, HOLD, HOLD]);
  });

  it("8分の連打が16分でも連打のまま残る", () => {
    const to = rescaleSteps([5, 5], 2, 4, 8);
    expect(melodyToNotes(to, 0, 4, 0)).toHaveLength(2);
  });

  it("16分から8分に粗くしても音が消えない", () => {
    const to = rescaleSteps([5, HOLD, HOLD, HOLD], 4, 2, 4);
    const notes = melodyToNotes(to, 0, 2, 0);
    expect(notes).toHaveLength(1);
    expect(notes[0].dur).toBeGreaterThan(0);
  });

  it("時間の位置が保たれる", () => {
    // 8分の4ステップ目（2拍目）→ 16分の8ステップ目（同じ2拍目）
    const to = rescaleSteps([null, null, null, null, 9], 2, 4, 16);
    expect(to[8]).toBe(9);
  });

  it("はみ出す音は切り捨てる", () => {
    const to = rescaleSteps([0, 0, 0, 0], 2, 4, 4);
    expect(to).toHaveLength(4);
    expect(to.every((v) => v === null || typeof v === "number")).toBe(true);
  });

  it("空でも壊れない", () => {
    expect(rescaleSteps([], 2, 4, 4)).toEqual([null, null, null, null]);
    expect(rescaleSteps([0], 0, 4, 2)).toEqual([null, null]);
  });
});

describe("保存と復元を往復しても変わらない", () => {
  it("伸ばしと連打が混ざった曲がそのまま戻る", () => {
    const melody: Step[] = [0, HOLD, 0, null, 4, 4, HOLD];
    const song = normalizeSong({ melody, melodyFormat: 2, melodyStepsPerBeat: 4 });
    const again = normalizeSong({ ...song, melody: song.melody });
    expect(again.melody).toEqual(melody);
    // 伸ばした0 / 打ち直した0 / 4 / 伸ばした4 の4音
    expect(melodyToNotes(again.melody, 0, 4, 0)).toHaveLength(4);
  });
});
