/**
 * メロディの自動生成。
 *
 * 適当な音を並べても「メロディ」には聞こえない。ここでは、それらしく
 * 聞こえるために効く決まりごとだけを素直に実装している。
 *
 *   1. 拍の頭・コードの変わり目では、そのコードの構成音に着地する
 *   2. 動きは基本的に隣の音へ（跳ぶのはたまに）
 *   3. 大きく跳んだら、次は反対向きに戻す
 *   4. リズムは小節ごとに使い回す（同じ形が返ってくると「まとまり」に聞こえる）
 *   5. 山を作って、最後は主音か構成音に降りる
 *
 * 生成結果はステップ配列としてそのまま保存する。種を保存しないのは、
 * 同じ曲を開いたら必ず同じ音が鳴ってほしいから。作り直したいときは
 * もう一度押せばよい。
 */

import { mod12 } from "./notes";
import { REST, type Step } from "./melody";

/** メロディを載せるコードの情報。 */
export interface ChordSpan {
  startBeat: number;
  beats: number;
  /** 構成音のピッチクラス（実音）。 */
  pitchClasses: number[];
}

export interface GenerateOptions {
  chords: ChordSpan[];
  beatsPerLoop: number;
  beatsPerBar: number;
  stepsPerBeat: number;
  tonic: number;
  /** スケールの構成音（主音からの半音数）。 */
  scaleDegrees: number[];
  /** 音の詰まり具合。0=すかすか、1=びっしり。 */
  density: number;
  /** 跳躍のしやすさ。0=隣の音だけ、1=よく跳ぶ。 */
  leapiness: number;
  seed: number;
}

/** 音域の上限（主音からの半音数）。ピアノロールの行数に合わせてある。 */
const TOP = 24;

/** 決定論的な擬似乱数。種が同じなら必ず同じ結果になる。 */
function rng(seed: number): () => number {
  let s = (seed >>> 0) || 1;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 0x100000000;
  };
}

/** 音の並び（主音からの半音数）を低い順に。スケール音だけを使う。 */
function buildLadder(scaleDegrees: number[]): number[] {
  const ladder: number[] = [];
  for (let offset = 0; offset <= TOP; offset++) {
    if (scaleDegrees.includes(mod12(offset))) ladder.push(offset);
  }
  return ladder;
}

/**
 * 1小節ぶんのリズムを作る。返すのは音の長さ（ステップ数）の並び。
 * 負の数は休符を表す。
 */
function makeBarRhythm(stepsPerBar: number, density: number, rand: () => number): number[] {
  // 詰まっているほど短い音を選びやすくする
  const choices = density > 0.7 ? [1, 1, 2] : density > 0.45 ? [1, 2, 2, 3] : [2, 2, 3, 4];
  const out: number[] = [];
  let left = stepsPerBar;
  while (left > 0) {
    const want = choices[Math.floor(rand() * choices.length)];
    const dur = Math.min(want, left);
    // すかすかなほど休符が増える
    const rest = rand() > 0.25 + density * 0.6;
    out.push(rest ? -dur : dur);
    left -= dur;
  }
  return out;
}

/**
 * 小節ごとのリズムを組み立てる。
 *
 * 全部の小節を別々に作るとまとまりが出ないので、2種類だけ作って
 * A A B A の形に並べる。歌のような「戻ってくる感じ」はここで生まれる。
 */
function buildRhythm(
  bars: number,
  stepsPerBar: number,
  density: number,
  rand: () => number,
): number[][] {
  const a = makeBarRhythm(stepsPerBar, density, rand);
  const b = makeBarRhythm(stepsPerBar, density, rand);
  const layout: number[][] = [];
  for (let i = 0; i < bars; i++) {
    // 4小節のまとまりの3つめだけ変える
    layout.push(i % 4 === 2 ? b : a);
  }
  return layout;
}

/** そのステップに鳴っているコード。 */
function chordAt(chords: ChordSpan[], beat: number): ChordSpan | null {
  if (chords.length === 0) return null;
  for (const c of chords) {
    if (beat >= c.startBeat - 1e-9 && beat < c.startBeat + c.beats - 1e-9) return c;
  }
  return chords[chords.length - 1];
}

/** その高さがコードの構成音か。 */
function isChordTone(offset: number, tonic: number, chord: ChordSpan | null): boolean {
  if (!chord) return true;
  return chord.pitchClasses.includes(mod12(tonic + offset));
}

/**
 * 指定した位置のいちばん近いコード構成音を探す。
 *
 * スケール外のコード（借用和音など）でも必ず見つかるよう、
 * スケールの並びに無ければ半音単位で探しにいく。
 */
function nearestChordTone(
  ladder: number[],
  index: number,
  tonic: number,
  chord: ChordSpan | null,
): number {
  const from = ladder[index];
  let best = from;
  let bestDist = Infinity;
  for (const o of ladder) {
    if (!isChordTone(o, tonic, chord)) continue;
    const d = Math.abs(o - from);
    if (d < bestDist) {
      bestDist = d;
      best = o;
    }
  }
  if (bestDist < Infinity) return best;
  // スケールの並びに無い＝借用和音。半音で探す。
  for (let d = 0; d <= TOP; d++) {
    for (const o of [from - d, from + d]) {
      if (o >= 0 && o <= TOP && isChordTone(o, tonic, chord)) return o;
    }
  }
  return from;
}

/**
 * メロディを作る。
 *
 * 返すのは進行1周ぶんのステップ配列。空の進行なら空配列。
 */
export function generateMelody(o: GenerateOptions): Step[] {
  const total = Math.max(0, Math.round(o.beatsPerLoop * o.stepsPerBeat));
  if (total === 0 || o.chords.length === 0) return [];

  const rand = rng(o.seed);
  const ladder = buildLadder(o.scaleDegrees);
  if (ladder.length === 0) return [];

  const stepsPerBar = Math.max(1, Math.round(o.beatsPerBar * o.stepsPerBeat));
  const bars = Math.ceil(total / stepsPerBar);
  const rhythm = buildRhythm(bars, stepsPerBar, o.density, rand);

  const steps: Step[] = new Array(total).fill(REST);

  // 真ん中あたりから始める。上下どちらにも動ける位置。
  let index = Math.floor(ladder.length / 2);
  let lastLeap = 0;

  // 音を置く位置と長さを、リズムから順に取り出す
  const slots: Array<{ start: number; dur: number; rest: boolean }> = [];
  let cursor = 0;
  for (const bar of rhythm) {
    for (const d of bar) {
      const dur = Math.abs(d);
      if (cursor >= total) break;
      slots.push({ start: cursor, dur: Math.min(dur, total - cursor), rest: d < 0 });
      cursor += dur;
    }
    if (cursor >= total) break;
  }

  const sounding = slots.filter((s) => !s.rest);

  sounding.forEach((slot, i) => {
    const beat = slot.start / o.stepsPerBeat;
    const chord = chordAt(o.chords, beat);
    const onBeat = slot.start % o.stepsPerBeat === 0;
    const onBar = slot.start % stepsPerBar === 0;
    const last = i === sounding.length - 1;

    if (lastLeap !== 0) {
      // 跳んだ直後は反対向きへ戻す。跳びっぱなしにすると旋律が散らかる。
      index -= Math.sign(lastLeap);
      lastLeap = 0;
    } else {
      const leap = rand() < o.leapiness * (onBeat ? 1 : 0.4);
      const move = leap ? 2 + Math.floor(rand() * 3) : rand() < 0.75 ? 1 : 0;
      // 山を作る。前半は上がりやすく、後半は下がりやすい。
      const rising = i < sounding.length * 0.55;
      const up = rand() < (rising ? 0.62 : 0.34);
      const delta = (up ? move : -move) || 0;
      index += delta;
      if (leap) lastLeap = delta;
    }

    // 音域から出ないよう折り返す
    if (index < 0) index = Math.min(2, ladder.length - 1);
    if (index >= ladder.length) index = Math.max(0, ladder.length - 3);

    let offset = ladder[index];

    // 拍の頭・コードの変わり目・最後の音は、構成音に着地させる
    const mustLand = onBar || (onBeat && !isChordTone(offset, o.tonic, chord)) || last;
    if (mustLand) {
      offset = nearestChordTone(ladder, index, o.tonic, chord);
      const at = ladder.indexOf(offset);
      if (at >= 0) index = at;
    }

    // 最後は落ち着く音へ。主音があればそこへ降りる。
    if (last) {
      const tonicNear = ladder
        .filter((x) => mod12(x) === 0 && isChordTone(x, o.tonic, chord))
        .sort((a, b) => Math.abs(a - offset) - Math.abs(b - offset))[0];
      if (tonicNear !== undefined) offset = tonicNear;
    }

    // 同じ高さを続けて書くと1つの長い音になる
    for (let k = 0; k < slot.dur && slot.start + k < total; k++) {
      steps[slot.start + k] = offset;
    }
  });

  return steps;
}

/** 雰囲気の選択肢。密度と跳躍のしやすさをまとめて決める。 */
export const MELODY_MOODS = [
  { id: "calm", label: "おだやか", density: 0.3, leapiness: 0.12 },
  { id: "normal", label: "ふつう", density: 0.55, leapiness: 0.28 },
  { id: "lively", label: "にぎやか", density: 0.8, leapiness: 0.45 },
] as const;

export type MelodyMoodId = (typeof MELODY_MOODS)[number]["id"];

export function getMelodyMood(id: string): (typeof MELODY_MOODS)[number] {
  return MELODY_MOODS.find((m) => m.id === id) ?? MELODY_MOODS[1];
}
