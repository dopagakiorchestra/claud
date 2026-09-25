import { describe, expect, it } from "vitest";

import {
  chordIndexAtStep,
  fitSteps,
  hasMelody,
  HOLD,
  melodyMidi,
  melodyToNotes,
  pitchRowsFor,
  stepCount,
  usedOffsets,
  type Step,
} from "../src/music/melody";
import { buildArrangement, makeSlot, type Song } from "../src/music/song";
import { DEFAULT_SONG, normalizeSong } from "../src/state";

function songWith(patch: Partial<Song>): Song {
  return { ...DEFAULT_SONG, ...patch };
}

describe("音の高さと MIDI", () => {
  it("主音からの半音数が MIDI に対応する", () => {
    // C（tonic=0）の主音は C4 = 60
    expect(melodyMidi(0, 0)).toBe(60);
    expect(melodyMidi(0, 12)).toBe(72);
    expect(melodyMidi(0, 7)).toBe(67);
  });

  it("キーが変わると全体が移調される", () => {
    // 同じ「主音から7半音上」でも、キーが変われば実音が変わる
    expect(melodyMidi(2, 7) - melodyMidi(0, 7)).toBe(2);
    expect(melodyMidi(5, 0)).toBe(65);
  });

  it("オクターブ移動が効く", () => {
    expect(melodyMidi(0, 0, 1)).toBe(72);
    expect(melodyMidi(0, 0, -1)).toBe(48);
  });
});

describe("ピアノロールの行", () => {
  it("スケール音だけなら2オクターブで15行", () => {
    const rows = pitchRowsFor("major", 0, 2, false);
    expect(rows).toHaveLength(15);
    // 高い音が先（画面の上）
    expect(rows[0].offset).toBe(24);
    expect(rows.at(-1)!.offset).toBe(0);
  });

  it("半音表示なら25行", () => {
    expect(pitchRowsFor("major", 0, 2, true)).toHaveLength(25);
  });

  it("スケール外の行に印が付く", () => {
    const rows = pitchRowsFor("major", 0, 2, true);
    // Cメジャーに C# は無い
    const cSharp = rows.find((r) => r.offset === 1)!;
    expect(cSharp.inScale).toBe(false);
    const d = rows.find((r) => r.offset === 2)!;
    expect(d.inScale).toBe(true);
  });

  it("主音の行が分かる", () => {
    const rows = pitchRowsFor("major", 0, 2, false);
    expect(rows.filter((r) => r.isTonic).map((r) => r.offset)).toEqual([24, 12, 0]);
  });

  it("キーに応じた音名になる", () => {
    expect(pitchRowsFor("major", 0, 1, false).at(-1)!.name).toBe("C");
    expect(pitchRowsFor("major", 2, 1, false).at(-1)!.name).toBe("D");
    // ♭系のキーは♭表記
    expect(pitchRowsFor("major", 5, 1, false).at(-1)!.name).toBe("F");
    expect(pitchRowsFor("major", 10, 1, false).at(-1)!.name).toBe("Bb");
  });

  it("置いてある半音は、半音表示を切っていても行が出る", () => {
    // C# (offset 1) を置いた状態。半音表示は OFF。
    const rows = pitchRowsFor("major", 0, 2, false, [1]);
    const cSharp = rows.find((r) => r.offset === 1);
    expect(cSharp).toBeDefined();
    expect(cSharp!.inScale).toBe(false);
    // スケール音15行 + 置いた1音
    expect(rows).toHaveLength(16);
  });

  it("キーやスケールを変えて外れた音になっても行が残る", () => {
    // メジャーの長3度(4)は、マイナーではスケール外になる
    const rows = pitchRowsFor("minor", 0, 2, false, [4]);
    const third = rows.find((r) => r.offset === 4);
    expect(third).toBeDefined();
    expect(third!.inScale).toBe(false);
  });

  it("置いた音を渡しても並びは高い順のまま", () => {
    const rows = pitchRowsFor("major", 0, 2, false, [1, 6, 13]);
    const offsets = rows.map((r) => r.offset);
    expect(offsets).toEqual([...offsets].sort((a, b) => b - a));
  });

  it("同じ音を重ねて渡しても行は増えない", () => {
    const a = pitchRowsFor("major", 0, 2, false, [1, 1, 1]);
    const b = pitchRowsFor("major", 0, 2, false, [1]);
    expect(a).toHaveLength(b.length);
  });

  it("スケール音を渡しても行は増えない", () => {
    expect(pitchRowsFor("major", 0, 2, false, [0, 2, 4])).toHaveLength(15);
  });

  it("半音表示なら置いた音を渡しても25行のまま", () => {
    expect(pitchRowsFor("major", 0, 2, true, [1, 3])).toHaveLength(25);
  });

  it("音域の外に置かれた音でも行が出る", () => {
    // 共有リンクなどで音域外の値が入っていても、見えなくならない
    const rows = pitchRowsFor("major", 0, 2, false, [30]);
    expect(rows.find((r) => r.offset === 30)).toBeDefined();
    expect(rows[0].offset).toBe(30); // いちばん高いので先頭
  });

  it("マイナースケールでも行が作れる", () => {
    const rows = pitchRowsFor("minor", 9, 2, false);
    expect(rows).toHaveLength(15);
    expect(rows.at(-1)!.name).toBe("A");
  });
});

describe("ステップ配列の長さ合わせ", () => {
  it("拍数と細かさからステップ数が決まる", () => {
    expect(stepCount(16, 2)).toBe(32);
    expect(stepCount(16, 4)).toBe(64);
    expect(stepCount(12, 1)).toBe(12);
  });

  it("足りなければ休符で埋める", () => {
    expect(fitSteps([0, 2], 5)).toEqual([0, 2, null, null, null]);
  });

  it("長すぎれば切り詰める", () => {
    expect(fitSteps([0, 2, 4, 5], 2)).toEqual([0, 2]);
  });

  it("ちょうどならそのまま返す（同一参照）", () => {
    const steps: Step[] = [0, null];
    expect(fitSteps(steps, 2)).toBe(steps);
  });
});

describe("ステップから音符への変換", () => {
  it("単発の音が1つの音符になる", () => {
    const notes = melodyToNotes([0, null, null, null], 0, 2, 0);
    expect(notes).toHaveLength(1);
    expect(notes[0].midi).toBe(60);
    expect(notes[0].start).toBe(0);
    // 8分（1拍=2ステップ）なので長さは0.5拍ぶん
    expect(notes[0].dur).toBeCloseTo(0.5 * 0.98, 6);
  });

  it("伸ばしの印が続くと1つの長い音になる", () => {
    const notes = melodyToNotes([4, HOLD, HOLD, null], 0, 2, 0);
    expect(notes).toHaveLength(1);
    expect(notes[0].start).toBe(0);
    // 3ステップぶん＝1.5拍
    expect(notes[0].dur).toBeCloseTo(1.5 * 0.98, 6);
  });

  it("同じ音が隣り合っていれば別々に鳴る（連打できる）", () => {
    const notes = melodyToNotes([4, 4, 4, null], 0, 2, 0);
    expect(notes).toHaveLength(3);
    expect(notes.map((n) => n.start)).toEqual([0, 0.5, 1]);
    expect(new Set(notes.map((n) => n.midi)).size).toBe(1);
  });

  it("16分で同じ音を2つ並べても、2音目が鳴る", () => {
    const notes = melodyToNotes([0, 0, null, null], 0, 4, 0);
    expect(notes).toHaveLength(2);
    expect(notes.map((n) => n.start)).toEqual([0, 0.25]);
  });

  it("違う音が隣り合えば別の音符になる", () => {
    const notes = melodyToNotes([0, 2, 4], 0, 2, 0);
    expect(notes).toHaveLength(3);
    expect(notes.map((n) => n.midi)).toEqual([60, 62, 64]);
    expect(notes.map((n) => n.start)).toEqual([0, 0.5, 1]);
  });

  it("休符を挟めば同じ音でも分かれる", () => {
    const notes = melodyToNotes([0, null, 0], 0, 2, 0);
    expect(notes).toHaveLength(2);
    expect(notes.map((n) => n.start)).toEqual([0, 1]);
  });

  it("末尾まで伸びている音も正しく閉じる", () => {
    const notes = melodyToNotes([7, HOLD], 0, 2, 0);
    expect(notes).toHaveLength(1);
    expect(notes[0].dur).toBeCloseTo(1 * 0.98, 6);
  });

  it("音の無いところの伸ばしは休符として扱う", () => {
    expect(melodyToNotes([HOLD, HOLD], 0, 2, 0)).toEqual([]);
    const notes = melodyToNotes([null, HOLD, 5], 0, 2, 0);
    expect(notes).toHaveLength(1);
    expect(notes[0].start).toBe(1);
  });

  it("すべて休符なら音符は出ない", () => {
    expect(melodyToNotes([null, null, null], 0, 2, 0)).toEqual([]);
    expect(melodyToNotes([], 0, 2, 0)).toEqual([]);
  });

  it("16分でも位置が合う", () => {
    const notes = melodyToNotes([0, null, null, null, 4], 0, 4, 0);
    expect(notes.map((n) => n.start)).toEqual([0, 1]);
  });
});

describe("使われている音の抽出", () => {
  it("休符を除いた音を重複なしで返す", () => {
    expect(usedOffsets([0, null, 4, 0, null, 7]).sort((a, b) => a - b)).toEqual([0, 4, 7]);
  });

  it("空や全休符なら空", () => {
    expect(usedOffsets([])).toEqual([]);
    expect(usedOffsets([null, null])).toEqual([]);
  });

  it("0 を休符と取り違えない", () => {
    // offset 0（主音）は falsy なので、うっかり落とすと主音が消える
    expect(usedOffsets([0])).toEqual([0]);
  });
});

describe("メロディの有無", () => {
  it("1音でもあれば true", () => {
    expect(hasMelody([null, null, 3])).toBe(true);
    expect(hasMelody([null, null])).toBe(false);
    expect(hasMelody([])).toBe(false);
  });
});

describe("ステップが乗っているコード", () => {
  const chords = [
    { startBeat: 0, beats: 4 },
    { startBeat: 4, beats: 4 },
    { startBeat: 8, beats: 8 },
  ];

  it("拍位置から正しいコードを引く", () => {
    expect(chordIndexAtStep(0, 2, chords)).toBe(0);
    expect(chordIndexAtStep(7, 2, chords)).toBe(0); // 3.5拍目
    expect(chordIndexAtStep(8, 2, chords)).toBe(1); // 4拍目
    expect(chordIndexAtStep(16, 2, chords)).toBe(2); // 8拍目
  });

  it("範囲外は最後のコードに寄せる", () => {
    expect(chordIndexAtStep(999, 2, chords)).toBe(2);
  });

  it("コードが無ければ -1", () => {
    expect(chordIndexAtStep(0, 2, [])).toBe(-1);
  });
});

describe("アレンジへの反映", () => {
  const twoChords = [makeSlot(0, "maj", 4), makeSlot(5, "maj", 4)];

  it("メロディを切っていれば音符が出ない", () => {
    const arr = buildArrangement(
      songWith({ chords: twoChords, melodyEnabled: false, melody: [0, 2, 4] }),
    );
    expect(arr.melodyNotes).toEqual([]);
  });

  it("有効なら音符が出る", () => {
    const arr = buildArrangement(
      songWith({
        chords: twoChords,
        melodyEnabled: true,
        melodyStepsPerBeat: 2,
        melody: [0, null, 4],
      }),
    );
    expect(arr.melodyNotes.length).toBeGreaterThan(0);
    expect(arr.melodyNotes[0].midi).toBe(60);
  });

  it("くり返し回数ぶん並ぶ", () => {
    const base = { chords: twoChords, melodyEnabled: true, melody: [0, null, 4] };
    const once = buildArrangement(songWith({ ...base, repeats: 1 }));
    const twice = buildArrangement(songWith({ ...base, repeats: 2 }));
    expect(twice.melodyNotes).toHaveLength(once.melodyNotes.length * 2);
    // 2周目は1周分ずれた位置から始まる
    const loopBeats = once.beatsPerLoop;
    expect(twice.melodyNotes[once.melodyNotes.length].start).toBeCloseTo(
      once.melodyNotes[0].start + loopBeats,
      6,
    );
  });

  it("キーを変えるとメロディも移調される", () => {
    const base = { chords: twoChords, melodyEnabled: true, melody: [0, 4, 7] };
    const inC = buildArrangement(songWith({ ...base, tonic: 0 }));
    const inD = buildArrangement(songWith({ ...base, tonic: 2 }));
    expect(inD.melodyNotes).toHaveLength(inC.melodyNotes.length);
    for (let i = 0; i < inC.melodyNotes.length; i++) {
      expect(inD.melodyNotes[i].midi - inC.melodyNotes[i].midi).toBe(2);
    }
  });

  it("進行より長いメロディは切り詰められる", () => {
    const arr = buildArrangement(
      songWith({
        chords: [makeSlot(0, "maj", 4)],
        repeats: 1,
        melodyEnabled: true,
        melodyStepsPerBeat: 2,
        // 4拍 × 8分 = 8ステップぶんしか使われない
        melody: Array<Step>(100).fill(0),
      }),
    );
    const last = arr.melodyNotes.at(-1)!;
    expect(last.start + last.dur).toBeLessThanOrEqual(4.01);
  });

  it("同じ曲からは同じメロディが出る", () => {
    const song = songWith({ chords: twoChords, melodyEnabled: true, melody: [0, 2, null, 4] });
    expect(buildArrangement(song).melodyNotes).toEqual(buildArrangement(song).melodyNotes);
  });
});

describe("保存データの検証", () => {
  it("壊れたメロディでも安全な値になる", () => {
    const song = normalizeSong({
      melody: [0, "x", null, 999, -999, NaN, 4.7],
      melodyStepsPerBeat: 99,
      melodyOctave: 50,
      melodyVolume: 5,
      melodyInstrument: "<script>",
    });
    // 範囲外や数値でないものは休符になる
    expect(song.melody).toEqual([0, null, null, null, null, null, 5]);
    expect(song.melodyStepsPerBeat).toBe(DEFAULT_SONG.melodyStepsPerBeat);
    expect(Math.abs(song.melodyOctave)).toBeLessThanOrEqual(2);
    expect(song.melodyVolume).toBeLessThanOrEqual(1);
    expect(song.melodyInstrument).toBe(DEFAULT_SONG.melodyInstrument);
  });

  it("配列でなければ空になる", () => {
    expect(normalizeSong({ melody: "melody" }).melody).toEqual([]);
    expect(normalizeSong({}).melody).toEqual([]);
  });

  it("長すぎるメロディは打ち切られる", () => {
    expect(normalizeSong({ melody: Array(9999).fill(0) }).melody).toHaveLength(4096);
  });

  it("正常なメロディはそのまま通る", () => {
    const song = normalizeSong({ melody: [0, 4, 7, null], melodyStepsPerBeat: 4 });
    expect(song.melody).toEqual([0, 4, 7, null]);
    expect(song.melodyStepsPerBeat).toBe(4);
  });
});
