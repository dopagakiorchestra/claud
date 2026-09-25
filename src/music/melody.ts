/**
 * メロディ（単音の旋律）の扱い。
 *
 * 音の高さは主音からの半音数で持つ。コードと同じ方式なので、キーを変えると
 * メロディも一緒に移調される。
 *
 * 時間はステップ（拍を等分したマス）で持つ。ステップの配列そのものが
 * ピアノロールの見た目と一対一に対応するので、UI との受け渡しが単純になる。
 */

import { mod12, pcName } from "./notes";
import type { NoteEvent } from "./patterns";
import { getScale, type Scale } from "./scales";

/** 休符を表す。 */
export const REST = null;

/**
 * 直前の音を伸ばすことを表す印。
 *
 * これが無かった頃は「同じ高さが隣り合っていれば1つの長い音」という
 * 決まりにしていたが、それだと同じ音を続けて打ち直せない（2音目が
 * 鳴らない）。伸ばすことを明示的に書けるようにして、
 * 同じ高さが隣り合ったら別々の音として鳴るようにした。
 *
 * 音の高さと同じ配列に入れるので、高さとして起こり得ない値にしてある。
 */
export const HOLD = -128;

/** メロディの1ステップ。主音からの半音数、伸ばし、または休符。 */
export type Step = number | null;

/** そのステップで実際に鳴っている音。 */
export interface ResolvedStep {
  /** 鳴っている高さ。休符なら null。 */
  offset: number | null;
  /** 直前から伸びている途中か（＝ここでは発音しない）。 */
  held: boolean;
}

/**
 * ステップ配列を「各マスで何が鳴っているか」に展開する。
 *
 * 伸ばしの印は、それ自体には高さが無い。画面に出すにも音にするにも
 * 直前の音まで遡る必要があるので、一度ここで解決してから使う。
 */
export function resolveSteps(steps: Step[]): ResolvedStep[] {
  const out: ResolvedStep[] = [];
  let current: number | null = null;
  for (const s of steps) {
    if (s === HOLD) {
      // 音が無いところから伸ばしようがないので、その場合は休符として扱う
      out.push({ offset: current, held: current !== null });
    } else if (s === REST) {
      current = null;
      out.push({ offset: null, held: false });
    } else {
      current = s;
      out.push({ offset: s, held: false });
    }
  }
  return out;
}

/** ピアノロールの1行。 */
export interface PitchRow {
  /** 主音からの半音数。 */
  offset: number;
  /** 表示する音名。 */
  name: string;
  /** スケールの主音か（行の強調に使う）。 */
  isTonic: boolean;
  /** スケール内の音か。半音表示のときだけ false がありうる。 */
  inScale: boolean;
}

/** メロディが鳴る音域の下端（MIDI）。ここに主音が来る。 */
export const MELODY_BASE_MIDI = 60;

/** 主音からの半音数を実際の MIDI ノート番号にする。 */
export function melodyMidi(tonic: number, offset: number, octaveShift = 0): number {
  return MELODY_BASE_MIDI + mod12(tonic) + offset + octaveShift * 12;
}

/**
 * ピアノロールの行を作る。高い音が先（画面の上）に来る順で返す。
 *
 * chromatic=false ならスケール音だけ。行数が減って画面に収まりやすく、
 * 外れた音を置きにくくなる。
 *
 * used には「実際に置かれている音」を渡す。スケール外でも必ず行を作るので、
 * 置いた音が画面から消えることがない。半音を置いたあとに半音表示を切ったり、
 * キーやスケールを変えたりしても、音が鳴っているのにマスが見えない、
 * という状態にならないようにするため。
 */
export function pitchRows(
  scale: Scale,
  tonic: number,
  octaves: number,
  chromatic: boolean,
  used: Iterable<number> = [],
): PitchRow[] {
  const useFlats = shouldUseFlats(scale, tonic);
  const top = octaves * 12;
  const offsets = new Set<number>();

  for (let offset = 0; offset <= top; offset++) {
    if (chromatic || scale.degrees.includes(mod12(offset))) offsets.add(offset);
  }
  // 置かれている音は、音域の外にあっても必ず出す
  for (const offset of used) {
    if (Number.isFinite(offset)) offsets.add(Math.round(offset));
  }

  // 画面では高い音を上に並べる
  return [...offsets]
    .sort((a, b) => b - a)
    .map((offset) => ({
      offset,
      name: pcName(mod12(tonic) + offset, useFlats),
      isTonic: mod12(offset) === 0,
      inScale: scale.degrees.includes(mod12(offset)),
    }));
}

/** メロディの音名表記をフラット寄りにすべきか。キーの見た目に合わせる。 */
function shouldUseFlats(scale: Scale, tonic: number): boolean {
  // 主音がフラット系のキーなら♭表記。ここはコード名と同じ判断に揃えている。
  const flatTonics = [5, 10, 3, 8, 1, 6];
  return flatTonics.includes(mod12(tonic)) || (scale.minorish && flatTonics.includes(mod12(tonic)));
}

/** 進行の長さから、必要なステップ数を求める。 */
export function stepCount(totalBeats: number, stepsPerBeat: number): number {
  return Math.max(0, Math.round(totalBeats * stepsPerBeat));
}

/**
 * ステップ配列を必要な長さに合わせる。
 * 進行を伸ばしたら休符で埋め、縮めたら余りを捨てる。
 */
export function fitSteps(steps: Step[], length: number): Step[] {
  if (steps.length === length) return steps;
  if (steps.length > length) return steps.slice(0, length);
  return [...steps, ...Array<Step>(length - steps.length).fill(REST)];
}

/**
 * ステップ配列を音符イベントに変換する。
 *
 * 伸ばしの印が続く間は1つの音として伸ばす。同じ高さが隣り合っている
 * 場合は、それぞれ別の音として鳴らす（連打できるようにするため）。
 */
export function melodyToNotes(
  steps: Step[],
  tonic: number,
  stepsPerBeat: number,
  octaveShift: number,
  velocity = 0.8,
): NoteEvent[] {
  const out: NoteEvent[] = [];
  const stepBeats = 1 / stepsPerBeat;
  const resolved = resolveSteps(steps);

  let runStart = -1;
  let runOffset: number | null = null;

  const flush = (endIndex: number) => {
    if (runOffset === null || runStart < 0) return;
    out.push({
      start: runStart * stepBeats,
      dur: (endIndex - runStart) * stepBeats * 0.98,
      midi: melodyMidi(tonic, runOffset, octaveShift),
      vel: velocity,
    });
    runStart = -1;
    runOffset = null;
  };

  for (let i = 0; i < resolved.length; i++) {
    const r = resolved[i];
    if (r.held && runOffset !== null) continue; // 伸ばしている途中
    flush(i);
    if (r.offset !== null && !r.held) {
      runStart = i;
      runOffset = r.offset;
    }
  }
  flush(resolved.length);

  return out;
}

/** メロディが1音でも入っているか。 */
export function hasMelody(steps: Step[]): boolean {
  // 伸ばしの印だけが残っていても、鳴る音は無い
  return steps.some((s) => s !== REST && s !== HOLD);
}

/**
 * そのステップが今どのコードの上にあるか。
 * 「今のコードに合う音」を画面で示すのに使う。
 */
export function chordIndexAtStep(
  step: number,
  stepsPerBeat: number,
  chordStarts: Array<{ startBeat: number; beats: number }>,
): number {
  const beat = step / stepsPerBeat;
  for (let i = 0; i < chordStarts.length; i++) {
    const c = chordStarts[i];
    if (beat >= c.startBeat - 1e-9 && beat < c.startBeat + c.beats - 1e-9) return i;
  }
  return chordStarts.length - 1;
}

/** スケールIDから行を作る簡便版。 */
export function pitchRowsFor(
  scaleId: string,
  tonic: number,
  octaves: number,
  chromatic: boolean,
  used: Iterable<number> = [],
): PitchRow[] {
  return pitchRows(getScale(scaleId), tonic, octaves, chromatic, used);
}

/** メロディで実際に使われている音の高さ（重複なし）。 */
export function usedOffsets(steps: Step[]): number[] {
  const set = new Set<number>();
  for (const s of steps) if (s !== REST && s !== HOLD) set.add(s);
  return [...set];
}

/**
 * 細かさ（1拍あたりのステップ数）を変えて作り直す。
 *
 * 位置だけでなく音の長さも移す。伸ばしの印を1つずつ移すと、
 * 目が粗くなったときに間が抜けて音が切れてしまうため、
 * 一度「どこから何ステップ鳴るか」に戻してから置き直している。
 */
export function rescaleSteps(
  steps: Step[],
  fromStepsPerBeat: number,
  toStepsPerBeat: number,
  newLength: number,
): Step[] {
  const out: Step[] = new Array(Math.max(0, newLength)).fill(REST);
  if (fromStepsPerBeat <= 0 || toStepsPerBeat <= 0) return out;
  const scale = toStepsPerBeat / fromStepsPerBeat;
  const resolved = resolveSteps(steps);

  let i = 0;
  while (i < resolved.length) {
    const r = resolved[i];
    if (r.offset === null || r.held) {
      i++;
      continue;
    }
    let len = 1;
    while (i + len < resolved.length && resolved[i + len].held) len++;

    const start = Math.round(i * scale);
    const span = Math.max(1, Math.round(len * scale));
    for (let k = 0; k < span && start + k < out.length; k++) {
      out[start + k] = k === 0 ? r.offset : HOLD;
    }
    i += len;
  }
  return out;
}
