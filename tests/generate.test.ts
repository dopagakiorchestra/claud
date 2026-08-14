/**
 * メロディ自動生成のテスト。
 *
 * 「良いメロディか」は測れないが、それらしく聞こえるための決まりごとが
 * 守れているかは測れる。ここではその決まりごとを確かめる。
 */

import { describe, expect, it } from "vitest";

import { generateMelody, getMelodyMood, MELODY_MOODS, type ChordSpan } from "../src/music/generate";
import { hasMelody, type Step } from "../src/music/melody";
import { mod12 } from "../src/music/notes";
import { getScale } from "../src/music/scales";
import { makeSlot, resolveChords } from "../src/music/song";
import { DEFAULT_SONG } from "../src/state";

const MAJOR = getScale("major").degrees;

/** 既定の進行（Fmaj7 - G7 - Em7 - Am7）を生成用の形にする。 */
function defaultChords(): ChordSpan[] {
  return resolveChords(DEFAULT_SONG).map((c) => ({
    startBeat: c.startBeat,
    beats: c.beats,
    pitchClasses: c.pitchClasses,
  }));
}

function gen(patch: Partial<Parameters<typeof generateMelody>[0]> = {}): Step[] {
  return generateMelody({
    chords: defaultChords(),
    beatsPerLoop: 16,
    beatsPerBar: 4,
    stepsPerBeat: 2,
    tonic: 0,
    scaleDegrees: MAJOR,
    density: 0.55,
    leapiness: 0.28,
    seed: 12345,
    ...patch,
  });
}

/** 連続する同じ高さをまとめて、鳴る音の並びにする。 */
function notes(steps: Step[]): Array<{ offset: number; at: number; len: number }> {
  const out: Array<{ offset: number; at: number; len: number }> = [];
  for (let i = 0; i < steps.length; i++) {
    const v = steps[i];
    if (v === null) continue;
    if (out.length > 0 && steps[i - 1] === v) out[out.length - 1].len++;
    else out.push({ offset: v, at: i, len: 1 });
  }
  return out;
}

describe("生成されるかたち", () => {
  it("進行の長さぴったりのステップ配列が返る", () => {
    expect(gen()).toHaveLength(32);
    expect(gen({ stepsPerBeat: 4 })).toHaveLength(64);
  });

  it("音が入っている", () => {
    expect(hasMelody(gen())).toBe(true);
    expect(notes(gen()).length).toBeGreaterThan(4);
  });

  it("進行が空なら空が返る", () => {
    expect(gen({ chords: [] })).toEqual([]);
  });

  it("長さ0なら空が返る", () => {
    expect(gen({ beatsPerLoop: 0 })).toEqual([]);
  });

  it("同じ種なら必ず同じ結果になる", () => {
    expect(gen({ seed: 777 })).toEqual(gen({ seed: 777 }));
  });

  it("種が違えば別のメロディになる", () => {
    const a = gen({ seed: 1 });
    const b = gen({ seed: 2 });
    expect(a).not.toEqual(b);
  });
});

describe("音の高さの決まりごと", () => {
  it("スケールの音か、コードの構成音しか出てこない", () => {
    for (const seed of [1, 2, 3, 42, 999]) {
      const chords = defaultChords();
      const steps = gen({ seed });
      const allChordTones = new Set(chords.flatMap((c) => c.pitchClasses));
      for (const n of notes(steps)) {
        const inScale = MAJOR.includes(mod12(n.offset));
        const isChordTone = allChordTones.has(mod12(n.offset));
        expect(inScale || isChordTone, `seed=${seed} offset=${n.offset}`).toBe(true);
      }
    }
  });

  it("音域から出ない", () => {
    for (const seed of [1, 5, 50, 500, 5000]) {
      for (const n of notes(gen({ seed }))) {
        expect(n.offset).toBeGreaterThanOrEqual(0);
        expect(n.offset).toBeLessThanOrEqual(24);
      }
    }
  });

  it("小節の頭はコードの構成音に着地する", () => {
    const chords = defaultChords();
    const stepsPerBar = 8; // 4拍 × 8分
    for (const seed of [1, 2, 3, 7, 11]) {
      const steps = gen({ seed });
      for (const n of notes(steps)) {
        if (n.at % stepsPerBar !== 0) continue;
        const beat = n.at / 2;
        const chord = chords.find(
          (c) => beat >= c.startBeat && beat < c.startBeat + c.beats,
        );
        expect(
          chord!.pitchClasses.includes(mod12(n.offset)),
          `seed=${seed} 小節頭 offset=${n.offset}`,
        ).toBe(true);
      }
    }
  });

  it("最後の音はコードの構成音で終わる", () => {
    const chords = defaultChords();
    for (const seed of [1, 2, 3, 4, 5, 6]) {
      const ns = notes(gen({ seed }));
      const last = ns[ns.length - 1];
      const beat = last.at / 2;
      const chord = chords.find((c) => beat >= c.startBeat && beat < c.startBeat + c.beats);
      expect(chord!.pitchClasses.includes(mod12(last.offset)), `seed=${seed}`).toBe(true);
    }
  });

  it("大きく跳びっぱなしにならない", () => {
    for (const seed of [1, 2, 3, 4, 5]) {
      const ns = notes(gen({ seed }));
      // 半音7つ（5度）を超える跳躍が2回続かないこと
      for (let i = 2; i < ns.length; i++) {
        const a = Math.abs(ns[i - 1].offset - ns[i - 2].offset);
        const b = Math.abs(ns[i].offset - ns[i - 1].offset);
        expect(a > 7 && b > 7, `seed=${seed} i=${i}`).toBe(false);
      }
    }
  });

  it("ほとんどの動きは隣どうし", () => {
    let small = 0;
    let all = 0;
    for (const seed of [1, 2, 3, 4, 5, 6, 7, 8]) {
      const ns = notes(gen({ seed }));
      for (let i = 1; i < ns.length; i++) {
        const d = Math.abs(ns[i].offset - ns[i - 1].offset);
        if (d <= 2) small++;
        all++;
      }
    }
    // 半数以上は全音以内で動いている
    expect(small / all).toBeGreaterThan(0.5);
  });

  it("同じ音がいつまでも続かない", () => {
    for (const seed of [1, 2, 3, 4, 5]) {
      const ns = notes(gen({ seed }));
      let run = 1;
      for (let i = 1; i < ns.length; i++) {
        run = ns[i].offset === ns[i - 1].offset ? run + 1 : 1;
        expect(run, `seed=${seed}`).toBeLessThanOrEqual(4);
      }
    }
  });
});

describe("リズム", () => {
  it("音の長さがステップの整数倍になっている", () => {
    for (const n of notes(gen())) {
      expect(Number.isInteger(n.len)).toBe(true);
      expect(n.len).toBeGreaterThan(0);
    }
  });

  it("小節どうしで同じリズムが返ってくる", () => {
    // 2小節目と1小節目、あるいは4小節目と1小節目で、
    // 音の置かれている位置がそろっている箇所があること
    const steps = gen({ seed: 3 });
    const onsets = (bar: number) => {
      const from = bar * 8;
      return steps
        .slice(from, from + 8)
        .map((v, i) => (v !== null && steps[from + i - 1] !== v ? i : -1))
        .filter((i) => i >= 0)
        .join(",");
    };
    const bars = [0, 1, 2, 3].map(onsets);
    const repeated = bars.filter((b, i) => bars.indexOf(b) !== i).length;
    expect(repeated).toBeGreaterThan(0);
  });

  it("にぎやかなほど音が増える", () => {
    const count = (density: number) => {
      let total = 0;
      for (const seed of [1, 2, 3, 4, 5, 6, 7, 8]) {
        total += notes(gen({ density, leapiness: 0.3, seed })).length;
      }
      return total;
    };
    expect(count(0.8)).toBeGreaterThan(count(0.3));
  });
});

describe("キーとスケール", () => {
  it("キーを変えても、その調の音で作られる", () => {
    // キーが変わっても保存するのは主音からの相対値なので、中身は同じでよい。
    // ここではスケール外の音が混ざらないことを確かめる。
    const steps = gen({ tonic: 7, seed: 21 });
    const chordTones = new Set(defaultChords().flatMap((c) => c.pitchClasses));
    for (const n of notes(steps)) {
      const ok = MAJOR.includes(mod12(n.offset)) || chordTones.has(mod12(n.offset + 7));
      expect(ok, `offset=${n.offset}`).toBe(true);
    }
  });

  it("マイナースケールでも作れる", () => {
    const steps = gen({ scaleDegrees: getScale("minor").degrees, seed: 8 });
    expect(hasMelody(steps)).toBe(true);
  });

  it("借用和音があっても、その構成音に着地できる", () => {
    // スケール外の音を含むコード（C7 の Bb）を置く
    const chords = resolveChords({
      ...DEFAULT_SONG,
      chords: [makeSlot(0, "7", 4), makeSlot(5, "maj", 4)],
    }).map((c) => ({ startBeat: c.startBeat, beats: c.beats, pitchClasses: c.pitchClasses }));
    const steps = generateMelody({
      chords,
      beatsPerLoop: 8,
      beatsPerBar: 4,
      stepsPerBeat: 2,
      tonic: 0,
      scaleDegrees: MAJOR,
      density: 0.55,
      leapiness: 0.3,
      seed: 5,
    });
    expect(hasMelody(steps)).toBe(true);
    const first = notes(steps)[0];
    expect(chords[0].pitchClasses.includes(mod12(first.offset))).toBe(true);
  });
});

describe("雰囲気の設定", () => {
  it("3種類そろっている", () => {
    expect(MELODY_MOODS.map((m) => m.id)).toEqual(["calm", "normal", "lively"]);
  });

  it("知らない名前ならふつうになる", () => {
    expect(getMelodyMood("なにこれ").id).toBe("normal");
  });

  it("にぎやかなほど密度も跳躍も大きい", () => {
    const [calm, normal, lively] = MELODY_MOODS;
    expect(calm.density).toBeLessThan(normal.density);
    expect(normal.density).toBeLessThan(lively.density);
    expect(calm.leapiness).toBeLessThan(lively.leapiness);
  });
});
