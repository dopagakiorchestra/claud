/**
 * 曲データのモデルと、そこから演奏イベント列（アレンジ）を組み立てる処理。
 *
 * ここで作った Arrangement を、試聴（AudioContext）とMP3書き出し
 * （OfflineAudioContext）の両方が共有する。だから「聴こえたとおりに書き出される」。
 */

import type { DanceSettings } from "../dance/choreo";
import { chordPitchClasses, prettyChordName } from "./chords";
import { fitSteps, melodyToNotes, stepCount, type Step } from "./melody";
import { mod12, prefersFlats } from "./notes";
import {
  getBassPattern,
  getChordPattern,
  getDrumPattern,
  renderDrums,
  type DrumEvent,
  type NoteEvent,
} from "./patterns";
import {
  DEGREE_LABEL,
  diatonicChords,
  getScale,
  romanFromNumeral,
  useFlatsForDegree,
} from "./scales";
import { buildVoicing } from "./voicing";

/** 進行上の1コード。root はキーの主音からの半音数で持つ（=キー変更で自動移調）。 */
export interface ChordSlot {
  /** UI で行を識別するための ID。 */
  id: string;
  /** 主音からの半音数（0..11）。 */
  offset: number;
  /** コードクオリティID。 */
  quality: string;
  /** 長さ（拍）。 */
  beats: number;
  /** 転回（0=基本形）。省略時は自動ボイシング。 */
  inversion?: number;
}

export interface Song {
  /** キーの主音のピッチクラス。 */
  tonic: number;
  scale: string;
  bpm: number;
  beatsPerBar: number;
  chords: ChordSlot[];
  chordPattern: string;
  bassPattern: string;
  drumPattern: string;
  instrument: string;
  bassEnabled: boolean;
  /** 和音の転回を自動で滑らかにするか。 */
  smoothVoicing: boolean;
  /** 繰り返し回数（書き出し時の長さ）。 */
  repeats: number;
  /** 0..1 のリバーブ量。 */
  reverb: number;
  /** 0..1 のマスター音量。 */
  volume: number;
  /** 末尾に1小節の余韻（無音＋残響）を足すか。 */
  tail: boolean;

  // --- メロディ ---
  /** メロディを鳴らすか。 */
  melodyEnabled: boolean;
  /** 各ステップの音。主音からの半音数、null は休符。 */
  melody: Step[];
  /** 1拍あたりのステップ数（2 = 8分, 4 = 16分）。 */
  melodyStepsPerBeat: number;
  melodyInstrument: string;
  /** メロディ全体のオクターブ移動（-1, 0, +1）。 */
  melodyOctave: number;
  /** 0..1 のメロディ音量。 */
  melodyVolume: number;

  // --- 振り付け ---
  /** ダンス動画の振り付け設定。曲と一緒に保存・共有される。 */
  dance: DanceSettings;
}

/** コード1つあたりの表示情報つき解析結果。 */
export interface ResolvedChord {
  slot: ChordSlot;
  /** 実音のルート（ピッチクラス）。 */
  rootPc: number;
  /** 表示用コード名。 */
  name: string;
  /** ローマ数字表記（ダイアトニック外は度数表記）。 */
  roman: string;
  /** 構成音のピッチクラス。 */
  pitchClasses: number[];
  /** 実際に鳴る和音の MIDI ノート。 */
  notes: number[];
  /** ベース音の MIDI ノート。 */
  bass: number;
  /** 開始位置（拍）。 */
  startBeat: number;
  /** 長さ（拍）。 */
  beats: number;
}

export interface Arrangement {
  /** 和音パートの音符。 */
  chordNotes: NoteEvent[];
  /** ベースパートの音符。 */
  bassNotes: NoteEvent[];
  /** メロディの音符。 */
  melodyNotes: NoteEvent[];
  /** ドラム。 */
  drums: DrumEvent[];
  /** 1リピート分の拍数。 */
  beatsPerLoop: number;
  /** 全体の拍数（リピート込み）。 */
  totalBeats: number;
  /** 1拍の秒数。 */
  secondsPerBeat: number;
  /** 音が鳴っている長さ（秒）。余韻は含まない。 */
  durationSeconds: number;
  /** 解析済みコード（1リピート分）。 */
  chords: ResolvedChord[];
}

let idCounter = 0;
export function newId(): string {
  idCounter += 1;
  return `c${Date.now().toString(36)}${idCounter.toString(36)}`;
}

export function makeSlot(offset: number, quality: string, beats = 4): ChordSlot {
  return { id: newId(), offset: mod12(offset), quality, beats };
}

/** このキーをフラット表記で書くべきか。 */
export function useFlatsForSong(song: Song): boolean {
  return prefersFlats(song.tonic);
}

/**
 * コードのローマ数字/度数表記。ダイアトニックなら通常のローマ数字、
 * 外れていれば "bVI" のような相対表記を返す。
 */
export function romanFor(song: Song, slot: ChordSlot): string {
  const scale = getScale(song.scale);
  const triads = diatonicChords(scale, false);
  const sevenths = diatonicChords(scale, true);
  const match =
    sevenths.find((d) => d.offset === slot.offset && d.quality === slot.quality) ??
    triads.find((d) => d.offset === slot.offset && d.quality === slot.quality);
  if (match) return match.roman;

  // ダイアトニック外: 主音からの度数を相対表記する。
  return romanFromNumeral(DEGREE_LABEL[mod12(slot.offset)], slot.quality);
}

/** 1リピート分のコードを解析して、実音・表示名・ボイシングを確定させる。 */
export function resolveChords(song: Song): ResolvedChord[] {
  const keyUseFlats = prefersFlats(song.tonic);
  const out: ResolvedChord[] = [];
  let beat = 0;
  let prevNotes: number[] | undefined;

  for (const slot of song.chords) {
    const rootPc = mod12(song.tonic + slot.offset);
    const voicing = buildVoicing(rootPc, slot.quality, {
      prev: prevNotes,
      smooth: song.smoothVoicing,
      inversion: slot.inversion,
    });
    prevNotes = voicing.notes;

    // bIII を D♯ ではなく E♭ と書くため、表記は度数に合わせる
    const useFlats = useFlatsForDegree(slot.offset, keyUseFlats);

    out.push({
      slot,
      rootPc,
      name: prettyChordName(
        rootPc,
        slot.quality,
        useFlats,
        slot.inversion ? voicing.bassPc : undefined,
      ),
      roman: romanFor(song, slot),
      pitchClasses: chordPitchClasses(rootPc, slot.quality),
      notes: voicing.notes,
      bass: voicing.bass,
      startBeat: beat,
      beats: slot.beats,
    });
    beat += slot.beats;
  }
  return out;
}

/** 曲全体を演奏イベント列に展開する。 */
export function buildArrangement(song: Song): Arrangement {
  const chords = resolveChords(song);
  const beatsPerLoop = chords.reduce((s, c) => s + c.beats, 0);
  const repeats = Math.max(1, Math.floor(song.repeats));
  const totalBeats = beatsPerLoop * repeats;
  const secondsPerBeat = 60 / song.bpm;

  const chordPattern = getChordPattern(song.chordPattern);
  const bassPattern = getBassPattern(song.bassPattern);
  const drumPattern = getDrumPattern(song.drumPattern);

  const chordNotes: NoteEvent[] = [];
  const bassNotes: NoteEvent[] = [];
  const melodyNotes: NoteEvent[] = [];

  // メロディは進行1周ぶんを作って、くり返しごとにずらして並べる
  const melodyLoop = song.melodyEnabled
    ? melodyToNotes(
        fitSteps(song.melody, stepCount(beatsPerLoop, song.melodyStepsPerBeat)),
        song.tonic,
        song.melodyStepsPerBeat,
        song.melodyOctave,
      )
    : [];

  for (let r = 0; r < repeats; r++) {
    const loopOffset = r * beatsPerLoop;
    for (const n of melodyLoop) {
      melodyNotes.push({ ...n, start: n.start + loopOffset });
    }
    for (const c of chords) {
      const start = loopOffset + c.startBeat;
      chordNotes.push(
        ...chordPattern.gen({
          notes: c.notes,
          start,
          length: c.beats,
          beatsPerBar: song.beatsPerBar,
        }),
      );
      if (song.bassEnabled) {
        bassNotes.push(
          ...bassPattern.gen({
            root: c.bass,
            fifth: c.bass + 7,
            start,
            length: c.beats,
            beatsPerBar: song.beatsPerBar,
          }),
        );
      }
    }
  }

  const drums = renderDrums(drumPattern, totalBeats, song.beatsPerBar);

  // イベントの終端も見て長さを決める（パターンが小節をまたぐ場合に切れないように）
  const lastNoteEnd = [...chordNotes, ...bassNotes, ...melodyNotes].reduce(
    (m, n) => Math.max(m, n.start + n.dur),
    0,
  );
  const endBeats = Math.max(totalBeats, lastNoteEnd);

  return {
    chordNotes,
    bassNotes,
    melodyNotes,
    drums,
    beatsPerLoop,
    totalBeats,
    secondsPerBeat,
    durationSeconds: endBeats * secondsPerBeat,
    chords,
  };
}

/** 進行の合計小節数（表示用）。 */
export function totalBars(song: Song): number {
  const beats = song.chords.reduce((s, c) => s + c.beats, 0);
  return beats / song.beatsPerBar;
}
