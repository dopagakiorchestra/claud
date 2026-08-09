import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { useHistory } from "./history";

import {
  artifactDownloads,
  BITRATES,
  downloadBlob,
  encodeMp3,
  encodeWav,
  renderSong,
  safeFilename,
  saveBlob,
  saveNeedsUserTap,
  saveViaArtifact,
  type Bitrate,
  type SaveOutcome,
} from "./audio/export";
import { pickRecorderFormat, recordBuffer } from "./audio/recorder";
import { isEmbedded, isIosDevice } from "./audio/compat";
import { INSTRUMENTS } from "./audio/instruments";
import { Player } from "./audio/player";
import { ChordCard } from "./components/ChordCard";
import { FloatingTransport } from "./components/FloatingTransport";
import { Keyboard } from "./components/Keyboard";
import { NumberField } from "./components/NumberField";
import { MelodyGrid } from "./components/MelodyGrid";
import { Palette } from "./components/Palette";
import {
  fitSteps,
  hasMelody,
  melodyMidi,
  pitchRowsFor,
  stepCount,
  usedOffsets,
} from "./music/melody";
import { pcName, prettyAccidentals } from "./music/notes";
import { DANCE_PAGE, pageUrl } from "./pages";
import { BASS_PATTERNS, CHORD_PATTERNS, DRUM_PATTERNS } from "./music/patterns";
import { PRESETS, presetToSlots } from "./music/presets";
import { SCALES } from "./music/scales";
import {
  buildArrangement,
  makeSlot,
  resolveChords,
  totalBars,
  useFlatsForSong,
  type ChordSlot,
  type Song,
} from "./music/song";
import {
  deleteSavedSong,
  listSavedSongs,
  loadSong,
  saveNamedSong,
  saveSong,
  shareUrl,
  suggestSongName,
  type SavedSong,
} from "./state";
import { SavedSongs, summarize } from "./components/SavedSongs";
import { Support } from "./components/Support";
import { useDragReorder } from "./useDragReorder";
import { useLongPressDrag } from "./useLongPressDrag";

type ExportState =
  | { kind: "idle" }
  | { kind: "working"; ratio: number; phase: "render" | "encode" | "record"; format: string }
  /**
   * 書き出しは終わったが、保存はまだ。
   * iOS では共有シートを開くのにユーザー操作が要るので、この状態でボタンを出す。
   */
  | {
      kind: "ready";
      blob: Blob;
      filename: string;
      url: string;
      needsTap: boolean;
      /** 実際に入っていたコーデック（録音経路のときだけ分かる）。 */
      codec?: string | null;
      /** AAC入りMP4なら、拡張子を .m4a に変えるだけで m4a として通用する。 */
      isAacMp4?: boolean;
    }
  | { kind: "error"; message: string };

export default function App() {
  const history = useHistory<Song>(loadSong);
  const song = history.present;
  /** 曲データの更新はすべて履歴経由。label が同じ連続操作は1件にまとまる。 */
  const setSong = history.set;

  const [loop, setLoop] = useState(true);
  /** 画面下に短時間出す通知（プリセット読み込みの取り消し用）。 */
  const [toast, setToast] = useState<string | null>(null);
  /** 名前を付けて保存した進行の一覧。 */
  const [saved, setSaved] = useState<SavedSong[]>(() => listSavedSongs());
  const [playing, setPlaying] = useState(false);
  const [activeChord, setActiveChord] = useState<number | null>(null);
  /** 再生中の拍位置（ループ内）。メロディの再生位置表示に使う。 */
  const [playPosition, setPlayPosition] = useState<number | null>(null);
  const [exportState, setExportState] = useState<ExportState>({ kind: "idle" });
  const [bitrate, setBitrate] = useState<Bitrate>(192);
  const [copied, setCopied] = useState(false);
  /** 直近の保存結果。iOS で保存経路が塞がれている場合の案内に使う。 */
  const [saveNote, setSaveNote] = useState<SaveOutcome | null>(null);

  const playerRef = useRef<Player | null>(null);
  /** 最後に再生を開始した設定。設定変更で組み直すべきかの判定に使う。 */
  const lastPlayedRef = useRef<{ song: Song; loop: boolean } | null>(null);
  const player = (): Player => {
    if (!playerRef.current) {
      const p = new Player();
      p.onEnded = () => {
        setPlaying(false);
        setActiveChord(null);
        setPlayPosition(null);
      };
      playerRef.current = p;
    }
    return playerRef.current;
  };

  const useFlats = useFlatsForSong(song);
  const resolved = useMemo(() => resolveChords(song), [song]);
  const arrangement = useMemo(() => buildArrangement(song), [song]);

  // 保存（少し待ってから書くことで、スライダー操作中の連続書き込みを避ける）
  useEffect(() => {
    const t = window.setTimeout(() => saveSong(song), 400);
    return () => window.clearTimeout(t);
  }, [song]);

  // 再生位置に応じてコードをハイライト
  useEffect(() => {
    if (!playing) return;
    let raf = 0;
    const tick = () => {
      const pos = playerRef.current?.position();
      setActiveChord(pos ? pos.chordIndex : null);
      setPlayPosition(pos ? pos.beat : null);
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [playing]);

  // 画面を離れるときは音を止める
  useEffect(() => () => playerRef.current?.stop(), []);

  // 通知は数秒で自動的に消す
  useEffect(() => {
    if (!toast) return;
    const t = window.setTimeout(() => setToast(null), 7000);
    return () => window.clearTimeout(t);
  }, [toast]);

  // キーボードからも取り消せるように（PCで使うとき用）
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey) || e.key.toLowerCase() !== "z") return;
      const el = e.target as HTMLElement | null;
      // 文字入力中は本来の取り消しに任せる
      if (el && (el.tagName === "INPUT" || el.tagName === "TEXTAREA")) return;
      e.preventDefault();
      if (e.shiftKey) history.redo();
      else history.undo();
      setToast(null);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [history]);

  const update = useCallback(
    (patch: Partial<Song>) => {
      // 変更したキーをラベルにすると、同じスライダーの連続操作が自然に1件にまとまる
      setSong((s) => ({ ...s, ...patch }), Object.keys(patch).join(","));
    },
    [setSong],
  );

  const updateChords = useCallback(
    (fn: (chords: ChordSlot[]) => ChordSlot[], label = "chords") => {
      setSong((s) => ({ ...s, chords: fn(s.chords) }), label);
    },
    [setSong],
  );

  const handlePlay = async () => {
    const p = player();
    if (playing) {
      p.stop();
      setPlaying(false);
      setActiveChord(null);
      setPlayPosition(null);
      return;
    }
    if (song.chords.length === 0) return;
    setPlaying(true);
    lastPlayedRef.current = { song, loop };
    try {
      await p.play(song, loop);
    } catch (err) {
      setPlaying(false);
      setExportState({
        kind: "error",
        message: `再生を開始できませんでした: ${describeError(err)}`,
      });
    }
  };

  /** 指定した拍から再生し直す。長い曲を頭から聴き直さずに確認できる。 */
  const seekTo = useCallback(
    (beat: number) => {
      if (song.chords.length === 0) return;
      const p = player();
      setPlaying(true);
      lastPlayedRef.current = { song, loop };
      p.play(song, loop, beat).catch((err: unknown) => {
        setPlaying(false);
        setExportState({
          kind: "error",
          message: `再生を開始できませんでした: ${describeError(err)}`,
        });
      });
    },
    [song, loop],
  );

  // 再生中に設定を変えたら、その場で組み直して変更を聴けるようにする。
  // 再生開始直後の二重再生を避けるため、最後に再生した設定と一致していたら何もしない。
  useEffect(() => {
    if (!playing) return;
    const p = playerRef.current;
    if (!p) return;
    const last = lastPlayedRef.current;
    if (last && last.song === song && last.loop === loop) return;
    const t = window.setTimeout(() => {
      lastPlayedRef.current = { song, loop };
      // 頭に戻さず、いま鳴っているところから鳴らし直す。
      // 途中を編集しているときに毎回冒頭へ飛ばされると確認しづらい。
      void p.play(song, loop, p.position()?.beat ?? 0);
    }, 220);
    return () => window.clearTimeout(t);
  }, [song, loop, playing]);

  const previewChord = (offset: number, quality: string) => {
    const slot = makeSlot(offset, quality);
    const probe = resolveChords({ ...song, chords: [slot] });
    void player().preview(song, probe[0].notes);
  };

  /** 前回作ったファイルの blob URL を解放する。 */
  const releaseExport = useCallback(() => {
    setExportState((prev) => {
      if (prev.kind === "ready") URL.revokeObjectURL(prev.url);
      return { kind: "idle" };
    });
  }, []);

  const doExport = async (format: "mp3" | "wav") => {
    if (song.chords.length === 0) return;
    releaseExport();
    playerRef.current?.stop();
    setPlaying(false);
    setExportState({ kind: "working", ratio: 0, phase: "render", format: format.toUpperCase() });
    try {
      const buffer = await renderSong(song, (ratio, phase) =>
        setExportState({ kind: "working", ratio, phase, format: format.toUpperCase() }),
      );
      const name = safeFilename(
        `${pcName(song.tonic, useFlats)}_${song.chords.length}chords_${song.bpm}bpm`,
      );

      let blob: Blob;
      let filename: string;
      if (format === "wav") {
        blob = encodeWav(buffer);
        filename = `${name}.wav`;
      } else {
        blob = await encodeMp3(buffer, bitrate, (ratio, phase) =>
          setExportState({ kind: "working", ratio, phase, format: "MP3" }),
        );
        filename = `${name}.mp3`;
      }

      // iOS Safari は blob URL の `<a download>` を無視するので、共有シートに渡す。
      // ただし共有シートはユーザー操作の直後しか開けず、ここまでの書き出しで
      // その権利が切れているため、改めてタップしてもらう。
      const needsTap = saveNeedsUserTap();
      if (!needsTap) downloadBlob(blob, filename);

      setExportState({
        kind: "ready",
        blob,
        filename,
        url: URL.createObjectURL(blob),
        needsTap,
      });
    } catch (err) {
      setExportState({
        kind: "error",
        message: `書き出しに失敗しました: ${describeError(err)}`,
      });
    }
  };

  /**
   * 埋め込み表示での書き出し。
   *
   * 埋め込みの中では mp3 / wav を渡せないので、MediaRecorder でブラウザ内蔵の
   * 形式（Safari なら AAC 入り MP4）を作り、Artifact の保存機能に渡す。
   * 録音は実時間かかるので、進捗を出しながら進める。
   */
  const doArtifactExport = async () => {
    if (song.chords.length === 0) return;
    releaseExport();
    playerRef.current?.stop();
    setPlaying(false);
    setSaveNote(null);

    const fmt = pickRecorderFormat();
    if (!fmt) {
      setExportState({
        kind: "error",
        message: "このブラウザは音声ファイルの作成に対応していません。",
      });
      return;
    }

    try {
      // 先に AudioContext を起こす。あとの await でユーザー操作の権利が切れるため、
      // クリック直後のこの時点で resume しておく必要がある。
      const ctx = await player().audioContext();

      setExportState({ kind: "working", ratio: 0, phase: "render", format: fmt.extension.toUpperCase() });
      const buffer = await renderSong(song, (ratio, phase) =>
        setExportState({ kind: "working", ratio, phase, format: fmt.extension.toUpperCase() }),
      );

      const { blob, format, codec, isAacMp4 } = await recordBuffer(ctx, buffer, (ratio) =>
        setExportState({
          kind: "working",
          ratio,
          phase: "record",
          format: fmt.extension.toUpperCase(),
        }),
      );

      const name = safeFilename(
        `${pcName(song.tonic, useFlats)}_${song.chords.length}chords_${song.bpm}bpm`,
      );
      const filename = `${name}.${format.extension}`;
      setExportState({
        kind: "ready",
        blob,
        filename,
        url: URL.createObjectURL(blob),
        needsTap: true,
        codec,
        isAacMp4,
      });
      // 録音の直後はまだ操作の権利が残っているので、そのまま保存を試す
      setSaveNote(await saveViaArtifact(blob, filename));
    } catch (err) {
      setExportState({
        kind: "error",
        message: `書き出しに失敗しました: ${describeError(err)}`,
      });
    }
  };

  /** 「保存」ボタン。ユーザー操作の中から共有シートを開く。 */
  const doSave = async () => {
    if (exportState.kind !== "ready") return;
    setSaveNote(null);
    try {
      // 埋め込み表示ではランタイムの保存機能が唯一の経路
      setSaveNote(
        artifactSave
          ? await saveViaArtifact(exportState.blob, exportState.filename)
          : await saveBlob(exportState.blob, exportState.filename),
      );
    } catch (err) {
      setExportState({ kind: "error", message: `保存できませんでした: ${describeError(err)}` });
    }
  };

  const copyShareUrl = async () => {
    const url = shareUrl(song);
    try {
      await navigator.clipboard.writeText(url);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1800);
    } catch {
      // クリップボードが使えない環境ではハッシュだけ書き換えて、URL欄からコピーしてもらう
      location.hash = new URL(url).hash;
    }
  };

  // --- 長押しドラッグでの並べ替え ---
  const cardRefs = useRef(new Map<string, HTMLDivElement>());
  const drag = useDragReorder({
    ids: song.chords.map((c) => c.id),
    getElement: (id) => cardRefs.current.get(id) ?? null,
    onCommit: (nextIds) =>
      updateChords((chords) => {
        const byId = new Map(chords.map((c) => [c.id, c]));
        return nextIds.map((id) => byId.get(id)).filter((c): c is ChordSlot => c !== undefined);
      }, "reorder"),
  });

  /** 画面に並べる順序。ドラッグ中だけ仮の順序を使う。 */
  const displayedChords = useMemo(() => {
    if (!drag.order) return resolved;
    const byId = new Map(resolved.map((c) => [c.slot.id, c]));
    return drag.order
      .map((id) => byId.get(id))
      .filter((c): c is (typeof resolved)[number] => c !== undefined);
  }, [drag.order, resolved]);

  // --- プリセットを長押しして進行に追加 ---
  const timelineRef = useRef<HTMLDivElement>(null);
  const dropZoneRef = useRef<HTMLDivElement>(null);

  const hitsDropTarget = useCallback((x: number, y: number) => {
    // 画面上部に出る固定のドロップ先か、進行そのものの上なら受け付ける
    for (const el of [dropZoneRef.current, timelineRef.current]) {
      if (!el) continue;
      const r = el.getBoundingClientRect();
      if (x >= r.left && x <= r.right && y >= r.top && y <= r.bottom) return true;
    }
    return false;
  }, []);

  const presetDrag = useLongPressDrag({
    isOverTarget: hitsDropTarget,
    onDrop: (id) => {
      const preset = PRESETS.find((p) => p.id === id);
      if (!preset) return;
      updateChords(
        (chords) => [...chords, ...presetToSlots(preset, song.beatsPerBar)],
        `append:${id}`,
      );
      setToast(`「${preset.name}」を末尾に追加しました`);
    },
  });

  const draggedPreset = PRESETS.find((p) => p.id === presetDrag.activeId) ?? null;

  // --- メロディ ---
  const [chromaticRows, setChromaticRows] = useState(false);

  /** 進行の長さに合わせたステップ配列。編集も再生もこれを基準にする。 */
  const melodySteps = useMemo(
    () => fitSteps(song.melody, stepCount(arrangement.beatsPerLoop, song.melodyStepsPerBeat)),
    [song.melody, song.melodyStepsPerBeat, arrangement.beatsPerLoop],
  );

  // 置いてある音は、スケール外でも必ず行を出す（鳴っているのに見えない、を防ぐ）
  const melodyUsed = useMemo(() => usedOffsets(melodySteps), [melodySteps]);

  const melodyRows = useMemo(
    () => pitchRowsFor(song.scale, song.tonic, 2, chromaticRows, melodyUsed),
    [song.scale, song.tonic, chromaticRows, melodyUsed],
  );

  const melodyHasNotes = hasMelody(melodySteps);

  /** マスをタップ。同じ音なら消し、違えば置き換える。 */
  const toggleMelodyStep = useCallback(
    (stepIndex: number, offset: number) => {
      setSong((s) => {
        const steps = fitSteps(
          s.melody,
          stepCount(
            s.chords.reduce((sum, c) => sum + c.beats, 0),
            s.melodyStepsPerBeat,
          ),
        );
        const next = [...steps];
        next[stepIndex] = next[stepIndex] === offset ? null : offset;
        // 音を置いたらメロディを自動的に有効にする（鳴らない理由を探させないため）
        return { ...s, melody: next, melodyEnabled: s.melodyEnabled || next[stepIndex] !== null };
      }, `melody:${stepIndex}`);
    },
    [setSong],
  );

  const clearMelody = useCallback(() => {
    setSong((s) => ({ ...s, melody: [] }), "melody-clear");
  }, [setSong]);

  /**
   * 細かさを変える。今あるメロディは時間の位置を保ったまま作り直す
   * （8分で作ったものを16分に変えても、鳴る位置が変わらないように）。
   */
  const changeMelodyResolution = useCallback(
    (next: number) => {
      setSong((s) => {
        const beats = s.chords.reduce((sum, c) => sum + c.beats, 0);
        const from = fitSteps(s.melody, stepCount(beats, s.melodyStepsPerBeat));
        const to = Array<number | null>(stepCount(beats, next)).fill(null);
        for (let i = 0; i < from.length; i++) {
          if (from[i] === null) continue;
          const at = Math.round((i / s.melodyStepsPerBeat) * next);
          if (at < to.length) to[at] = from[i];
        }
        return { ...s, melody: to, melodyStepsPerBeat: next };
      }, "melodySteps");
    },
    [setSong],
  );

  const previewMelodyRow = useCallback(
    (offset: number) => {
      void player().preview(song, [melodyMidi(song.tonic, offset, song.melodyOctave)]);
    },
    [song],
  );

  /** 再生中に光らせるステップ。 */
  const playingStep =
    playing && playPosition !== null
      ? Math.floor(playPosition * song.melodyStepsPerBeat) % Math.max(1, melodySteps.length)
      : null;

  const transportRef = useRef<HTMLElement>(null);
  const exportBusy = exportState.kind === "working";
  const embedded = isEmbedded();
  /** 埋め込み表示で使える保存機能。あるならこちらが唯一の保存経路。 */
  const artifactSave = artifactDownloads();
  const recorderFormat = pickRecorderFormat();
  /**
   * 保存する手段が本当に無い組み合わせ。
   * iOS で他ページに埋め込まれていて、かつランタイムの保存機能も無い場合。
   */
  const cannotSaveHere = embedded && isIosDevice() && !artifactSave;

  const bars = totalBars(song);
  const seconds = arrangement.durationSeconds;
  const highlightNotes =
    activeChord !== null && resolved[activeChord]
      ? [...resolved[activeChord].notes, resolved[activeChord].bass]
      : resolved[0]
        ? [...resolved[0].notes, resolved[0].bass]
        : [];
  const highlightRoot =
    activeChord !== null && resolved[activeChord]
      ? resolved[activeChord].rootPc
      : resolved[0]?.rootPc;

  return (
    <div className="app">
      <header className="header">
        <div>
          <h1>🎹 Chord Progression Studio</h1>
          <p className="sub">
            コード進行を組んで、その場で試聴して、MP3でダウンロード。すべてブラウザ内で完結します。
          </p>
          <p className="sub">
            <a className="page-link" href={pageUrl(DANCE_PAGE, song)}>
              💃 この進行で踊る動画を作る →
            </a>
          </p>
        </div>
      </header>

      {/* --- 再生・書き出し --- */}
      <section className="panel" ref={transportRef}>
        <div className="transport">
          <button className="btn primary" onClick={handlePlay} disabled={song.chords.length === 0}>
            {playing ? "■ 停止" : "▶ 試聴"}
          </button>

          <label className="checkline">
            <input type="checkbox" checked={loop} onChange={(e) => setLoop(e.target.checked)} />
            ループ
          </label>

          <div className="undo-group">
            <button
              className="btn small"
              onClick={() => {
                history.undo();
                setToast(null);
              }}
              disabled={!history.canUndo}
              title="元に戻す"
              aria-label="元に戻す"
            >
              ↶ 戻す
            </button>
            <button
              className="btn small"
              onClick={() => {
                history.redo();
                setToast(null);
              }}
              disabled={!history.canRedo}
              title="やり直す"
              aria-label="やり直す"
            >
              ↷
            </button>
          </div>

          <span className="spacer" />

          {artifactSave ? (
            // 埋め込み表示。mp3 / wav は渡せないので、ブラウザ内蔵の形式で保存する。
            <button
              className="btn accent"
              onClick={() => void doArtifactExport()}
              disabled={exportBusy || song.chords.length === 0 || !recorderFormat}
              title={
                recorderFormat
                  ? `${recorderFormat.label} として保存します`
                  : "このブラウザでは音声ファイルを作成できません"
              }
            >
              ⬇ 音声ファイルを保存
              {recorderFormat ? `（${recorderFormat.extension}）` : ""}
            </button>
          ) : (
            <>
              <div className="field">
                <label htmlFor="bitrate">ビットレート</label>
                <select
                  id="bitrate"
                  value={bitrate}
                  onChange={(e) => setBitrate(Number(e.target.value) as Bitrate)}
                >
                  {BITRATES.map((b) => (
                    <option key={b} value={b}>
                      {b} kbps
                    </option>
                  ))}
                </select>
              </div>

              <button
                className="btn accent"
                onClick={() => void doExport("mp3")}
                disabled={exportBusy || song.chords.length === 0}
              >
                ⬇ MP3をダウンロード
              </button>
              <button
                className="btn"
                onClick={() => void doExport("wav")}
                disabled={exportBusy || song.chords.length === 0}
              >
                WAV
              </button>
            </>
          )}
          <button className="btn ghost" onClick={() => void copyShareUrl()}>
            {copied ? "✓ コピーしました" : "🔗 共有リンク"}
          </button>
        </div>

        <div className="status" style={{ marginTop: 10 }}>
          {bars % 1 === 0 ? bars : bars.toFixed(2)} 小節 / {song.repeats} 回くり返し ={" "}
          {formatDuration(seconds)}
          {exportState.kind === "working" && (
            <>
              {" — "}
              {exportState.format}{" "}
              {exportState.phase === "render"
                ? "レンダリング中"
                : exportState.phase === "record"
                  ? "音声ファイルを作成中（曲の長さぶん時間がかかります）"
                  : "エンコード中"}{" "}
              {Math.round(exportState.ratio * 100)}%
            </>
          )}
        </div>

        {exportState.kind === "working" && (
          <div className="progress">
            <div
              style={{
                width: `${Math.round(
                  (exportState.phase === "render" ? 0.15 : 0.15 + exportState.ratio * 0.85) * 100,
                )}%`,
              }}
            />
          </div>
        )}

        {cannotSaveHere && exportState.kind === "idle" && (
          <p className="notice">
            ⚠️ この表示は他のページに埋め込まれているため、
            <strong>iPhone では音声ファイルを保存できません</strong>
            （試聴は問題なくできます）。保存したいときは、このアプリを通常のWebページとして
            開いてください。
          </p>
        )}

        {artifactSave && exportState.kind === "idle" && (
          <p className="notice">
            この表示では <strong>{recorderFormat?.label ?? "音声"}</strong>{" "}
            として保存します（埋め込み表示では MP3 を渡せないため）。Suno などへの
            アップロードにも使えます（弾かれる場合は拡張子を .m4a に変更）。作成中は
            曲の長さぶん待ち時間があるので、画面を開いたままにしてください。
          </p>
        )}

        {exportState.kind === "ready" && (
          <div className="save-ready">
            <div className="save-file">
              <span className="save-name">{exportState.filename}</span>
              <span className="save-size">{formatBytes(exportState.blob.size)}</span>
            </div>
            <button className="btn accent" onClick={() => void doSave()}>
              {saveNote === "downloaded" ? "もう一度保存" : "📥 ファイルに保存"}
            </button>
            {/* blob リンクは埋め込みの中では機能しないので出さない */}
            {!artifactSave && (
              <a className="btn ghost small" href={exportState.url} download={exportState.filename}>
                直接リンク
              </a>
            )}
            <button className="btn ghost small" onClick={releaseExport} aria-label="閉じる">
              ✕
            </button>

            {artifactSave && saveNote === "downloaded" && (
              <div className="hint" style={{ flexBasis: "100%", margin: "4px 0 0" }}>
                <p style={{ margin: 0 }}>
                  ✅ 保存しました。iPhone なら「ファイル」アプリのダウンロードフォルダに入っています。
                </p>
                {exportState.isAacMp4 && (
                  <p style={{ margin: "6px 0 0" }}>
                    中身は <strong>AAC 音声</strong>です。Suno
                    などにアップロードして弾かれる場合は、
                    <strong>拡張子を .mp4 → .m4a に変えてください</strong>
                    （ファイルを長押し →「名前の変更」）。同じデータなので
                    作り直しも音質の劣化もありません。
                  </p>
                )}

                {exportState.codec && !exportState.isAacMp4 && (
                  <p style={{ margin: "6px 0 0" }}>
                    中身は <strong>{exportState.codec}</strong> です。
                    このブラウザは AAC で書き出せないため、mp3 / wav / m4a
                    しか受け付けないサービスには、そのままでは渡せないかもしれません
                    （拡張子を変えても中身は変わりません）。その場合は下の案内をご覧ください。
                  </p>
                )}
              </div>
            )}

            {artifactSave && saveNote === "cancelled" && (
              <p className="hint" style={{ flexBasis: "100%", margin: "4px 0 0" }}>
                保存を中止しました。「ファイルに保存」でもう一度確認できます。
              </p>
            )}

            {!artifactSave && exportState.needsTap && saveNote !== "blocked" && (
              <p className="hint" style={{ flexBasis: "100%", margin: "4px 0 0" }}>
                書き出しできました。「ファイルに保存」を押すと共有シートが開くので、
                <strong>「"ファイル"に保存」</strong>
                を選んでください。うまくいかないときは「直接リンク」を長押し →
                「リンク先のファイルをダウンロード」でも保存できます。
              </p>
            )}

            {saveNote === "opened" && (
              <p className="hint" style={{ flexBasis: "100%", margin: "4px 0 0" }}>
                別のタブでファイルを開きました。その画面の
                <strong>共有ボタン（□に↑）</strong>から「"ファイル"に保存」を選んでください。
              </p>
            )}

            {saveNote === "blocked" && (
              <div className="save-blocked">
                {embedded ? (
                  <>
                    <p>
                      <strong>埋め込み表示のままでは音声ファイルを保存できません。</strong>
                      他のページに埋め込まれた状態では、ブラウザが音声の保存経路を
                      すべて塞いでいます。アプリ側の不具合ではなく、回避もできません。
                    </p>
                    <p>
                      このアプリを<strong>通常のWebページとして開く</strong>と保存できます。
                      書き出した音は消えていないので、開き直したあとに
                      もう一度「MP3をダウンロード」を押してください。
                    </p>
                  </>
                ) : (
                  <>
                    <p>
                      <strong>このブラウザでは保存経路が塞がれていました。</strong>
                      共有シートもポップアップも許可されていないようです。
                    </p>
                    <p>
                      ブラウザの設定でポップアップのブロックを解除するか、
                      別のブラウザでお試しください。
                    </p>
                  </>
                )}
              </div>
            )}
          </div>
        )}

        {exportState.kind === "error" && <p className="error">{exportState.message}</p>}
      </section>

      {/* --- 曲の設定 --- */}
      <section className="panel">
        <h2>曲の設定</h2>
        <div className="row">
          <div className="field">
            <label htmlFor="tonic">キー</label>
            <select
              id="tonic"
              value={song.tonic}
              onChange={(e) => update({ tonic: Number(e.target.value) })}
            >
              {Array.from({ length: 12 }, (_, i) => (
                <option key={i} value={i}>
                  {prettyAccidentals(pcName(i, useFlats))}
                </option>
              ))}
            </select>
          </div>

          <div className="field">
            <label htmlFor="scale">スケール</label>
            <select
              id="scale"
              value={song.scale}
              onChange={(e) => update({ scale: e.target.value })}
            >
              {SCALES.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.label}
                </option>
              ))}
            </select>
          </div>

          <div className="field">
            <label htmlFor="bpm">テンポ（BPM）</label>
            <NumberField
              id="bpm"
              min={30}
              max={300}
              step={1}
              value={song.bpm}
              ariaLabel="テンポ"
              steppers
              width={64}
              onChange={(bpm) => update({ bpm })}
            />
          </div>

          <div className="field">
            <label htmlFor="bpb">拍子（1小節の拍数）</label>
            <select
              id="bpb"
              value={song.beatsPerBar}
              onChange={(e) => update({ beatsPerBar: Number(e.target.value) })}
            >
              {[2, 3, 4, 5, 6, 7].map((b) => (
                <option key={b} value={b}>
                  {b}/4
                </option>
              ))}
            </select>
          </div>

          <div className="field">
            <label htmlFor="repeats">くり返し回数</label>
            <NumberField
              id="repeats"
              min={1}
              max={16}
              step={1}
              value={song.repeats}
              ariaLabel="くり返し回数"
              steppers
              width={48}
              onChange={(repeats) => update({ repeats })}
            />
          </div>
        </div>

        <div className="row" style={{ marginTop: 12 }}>
          <div className="field">
            <label htmlFor="instrument">音色</label>
            <select
              id="instrument"
              value={song.instrument}
              onChange={(e) => update({ instrument: e.target.value })}
            >
              {INSTRUMENTS.map((i) => (
                <option key={i.id} value={i.id}>
                  {i.label}
                </option>
              ))}
            </select>
          </div>

          <div className="field">
            <label htmlFor="chordPattern">弾き方</label>
            <select
              id="chordPattern"
              value={song.chordPattern}
              onChange={(e) => update({ chordPattern: e.target.value })}
            >
              {CHORD_PATTERNS.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.label}
                </option>
              ))}
            </select>
          </div>

          <div className="field">
            <label htmlFor="bassPattern">ベース</label>
            <select
              id="bassPattern"
              value={song.bassPattern}
              onChange={(e) => update({ bassPattern: e.target.value })}
              disabled={!song.bassEnabled}
            >
              {BASS_PATTERNS.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.label}
                </option>
              ))}
            </select>
          </div>

          <div className="field">
            <label htmlFor="drumPattern">ドラム</label>
            <select
              id="drumPattern"
              value={song.drumPattern}
              onChange={(e) => update({ drumPattern: e.target.value })}
            >
              {DRUM_PATTERNS.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.label}
                </option>
              ))}
            </select>
          </div>

          <div className="field">
            <label htmlFor="reverb">リバーブ {Math.round(song.reverb * 100)}%</label>
            <input
              id="reverb"
              type="range"
              min={0}
              max={100}
              value={Math.round(song.reverb * 100)}
              onChange={(e) => update({ reverb: Number(e.target.value) / 100 })}
            />
          </div>

          <div className="field">
            <label htmlFor="volume">音量 {Math.round(song.volume * 100)}%</label>
            <input
              id="volume"
              type="range"
              min={0}
              max={100}
              value={Math.round(song.volume * 100)}
              onChange={(e) => update({ volume: Number(e.target.value) / 100 })}
            />
          </div>
        </div>

        <div className="row" style={{ marginTop: 12 }}>
          <label className="checkline">
            <input
              type="checkbox"
              checked={song.bassEnabled}
              onChange={(e) => update({ bassEnabled: e.target.checked })}
            />
            ベースを鳴らす
          </label>
          <label className="checkline">
            <input
              type="checkbox"
              checked={song.smoothVoicing}
              onChange={(e) => update({ smoothVoicing: e.target.checked })}
            />
            なめらかなボイシング（転回を自動選択）
          </label>
          <label className="checkline">
            <input
              type="checkbox"
              checked={song.tail}
              onChange={(e) => update({ tail: e.target.checked })}
            />
            書き出しに余韻を残す
          </label>
        </div>
      </section>

      {/* --- 進行 --- */}
      <section className="panel">
        <h2>コード進行</h2>
        <div className="timeline" ref={timelineRef}>
          {displayedChords.map((c, i) => (
            <ChordCard
              key={c.slot.id}
              chord={c}
              index={i}
              total={displayedChords.length}
              active={playing && !drag.draggingId && resolved[activeChord ?? -1]?.slot.id === c.slot.id}
              useFlats={useFlats}
              dragging={drag.draggingId === c.slot.id}
              dragHandlers={drag.handlers(c.slot.id)}
              registerElement={(el) => {
                if (el) cardRefs.current.set(c.slot.id, el);
                else cardRefs.current.delete(c.slot.id);
              }}
              onPreview={() => void player().preview(song, c.notes)}
              onChange={(patch) =>
                updateChords((chords) =>
                  chords.map((s) =>
                    s.id === c.slot.id
                      ? {
                          ...s,
                          ...patch,
                          ...(patch.inversion !== undefined
                            ? { inversion: patch.inversion || undefined }
                            : {}),
                        }
                      : s,
                  ),
                )
              }
              onMove={(delta) =>
                updateChords((chords) => {
                  const from = chords.findIndex((s) => s.id === c.slot.id);
                  const to = from + delta;
                  if (from < 0 || to < 0 || to >= chords.length) return chords;
                  const next = [...chords];
                  [next[from], next[to]] = [next[to], next[from]];
                  return next;
                })
              }
              onDuplicate={() =>
                updateChords((chords) => {
                  // 進行を組み立てている末尾に足したいので、隣ではなく最後に置く
                  const copy = makeSlot(c.slot.offset, c.slot.quality, c.slot.beats);
                  if (c.slot.inversion) copy.inversion = c.slot.inversion;
                  return [...chords, copy];
                }, "copy")
              }
              onRemove={() => updateChords((chords) => chords.filter((s) => s.id !== c.slot.id))}
            />
          ))}

          <button
            className="add-card"
            onClick={() =>
              updateChords((chords) => [
                ...chords,
                makeSlot(0, "maj", chords.at(-1)?.beats ?? song.beatsPerBar),
              ])
            }
          >
            ＋ コードを追加
          </button>
        </div>

        {song.chords.length > 0 && (
          <>
            <div style={{ marginTop: 16 }}>
              <Keyboard highlight={highlightNotes} rootPc={highlightRoot} />
            </div>
            <p className="hint">
              コード名をタップするとその和音だけ鳴ります。「拍数」で長さ、「転回」で分数コードに。
              <br />
              <strong>カードを長押しするとドラッグで並べ替え</strong>できます。⧉
              は末尾にコピー、←→ でも移動できます。
            </p>
          </>
        )}

        {song.chords.length === 0 && (
          <p className="hint">
            進行が空です。下のプリセットかコードパレットから追加してください。
          </p>
        )}
      </section>

      {/* --- メロディ --- */}
      <section className="panel">
        <h2>メロディ</h2>

        <div className="row" style={{ marginBottom: 12 }}>
          <label className="checkline">
            <input
              type="checkbox"
              checked={song.melodyEnabled}
              onChange={(e) => update({ melodyEnabled: e.target.checked })}
            />
            メロディを鳴らす
          </label>

          <div className="field">
            <label htmlFor="melodyInstrument">音色</label>
            <select
              id="melodyInstrument"
              value={song.melodyInstrument}
              onChange={(e) => update({ melodyInstrument: e.target.value })}
            >
              {INSTRUMENTS.map((i) => (
                <option key={i.id} value={i.id}>
                  {i.label}
                </option>
              ))}
            </select>
          </div>

          <div className="field">
            <label htmlFor="melodySteps">細かさ</label>
            <select
              id="melodySteps"
              value={song.melodyStepsPerBeat}
              onChange={(e) => changeMelodyResolution(Number(e.target.value))}
            >
              <option value={1}>4分音符</option>
              <option value={2}>8分音符</option>
              <option value={3}>3連符</option>
              <option value={4}>16分音符</option>
            </select>
          </div>

          <div className="field">
            <label htmlFor="melodyOctave">オクターブ</label>
            <select
              id="melodyOctave"
              value={song.melodyOctave}
              onChange={(e) => update({ melodyOctave: Number(e.target.value) })}
            >
              <option value={-1}>低い</option>
              <option value={0}>標準</option>
              <option value={1}>高い</option>
            </select>
          </div>

          <div className="field">
            <label htmlFor="melodyVolume">音量 {Math.round(song.melodyVolume * 100)}%</label>
            <input
              id="melodyVolume"
              type="range"
              min={0}
              max={100}
              value={Math.round(song.melodyVolume * 100)}
              onChange={(e) => update({ melodyVolume: Number(e.target.value) / 100 })}
            />
          </div>

          <label className="checkline">
            <input
              type="checkbox"
              checked={chromaticRows}
              onChange={(e) => setChromaticRows(e.target.checked)}
            />
            半音も表示
          </label>

          <button
            className="btn small"
            onClick={clearMelody}
            disabled={!melodyHasNotes}
          >
            すべて消す
          </button>
        </div>

        <MelodyGrid
          rows={melodyRows}
          steps={melodySteps}
          stepsPerBeat={song.melodyStepsPerBeat}
          beatsPerBar={song.beatsPerBar}
          chords={resolved}
          playingStep={playingStep}
          onToggle={toggleMelodyStep}
          onPreviewRow={previewMelodyRow}
          onSeek={seekTo}
        />
      </section>

      {/* --- マイ進行 --- */}
      <SavedSongs
        saved={saved}
        suggestedName={suggestSongName(
          song,
          resolved.map((c) => c.name),
        )}
        currentSummary={summarize(resolved.map((c) => c.name))}
        summaryOf={(entry) => summarize(resolveChords(entry.song).map((c) => c.name))}
        onSave={(name) => {
          setSaved(saveNamedSong(name, song));
          setToast(`「${name}」を保存しました`);
        }}
        onLoad={(entry) => {
          setSong(entry.song, `saved:${entry.id}`);
          setToast(`「${entry.name}」を読み込みました`);
        }}
        onDelete={(entry) => setSaved(deleteSavedSong(entry.id))}
      />

      {/* --- パレット --- */}
      <Palette
        song={song}
        useFlats={useFlats}
        onAdd={(offset, quality) =>
          updateChords((chords) => [
            ...chords,
            makeSlot(offset, quality, chords.at(-1)?.beats ?? song.beatsPerBar),
          ])
        }
        onPreview={previewChord}
      />

      {/* --- プリセット --- */}
      <section className="panel">
        <h2>定番進行プリセット</h2>
        <div className="presets">
          {PRESETS.map((p) => (
            <button
              key={p.id}
              className={`preset${presetDrag.activeId === p.id ? " dragging" : ""}`}
              {...presetDrag.handlers(p.id)}
              onClick={() => {
                // 長押しドラッグの直後はクリックとして扱わない
                if (presetDrag.activeId) return;
                setSong(
                  (s) => ({ ...s, scale: p.scale, chords: presetToSlots(p, s.beatsPerBar) }),
                  `preset:${p.id}`,
                );
                // 今の進行が置き換わったことに気づけるよう、取り消し手段を出す
                setToast(`「${p.name}」を読み込みました`);
              }}
            >
              <div className="pname">{p.name}</div>
              <div className="phint">{p.hint}</div>
            </button>
          ))}
        </div>
        <p className="hint">
          タップすると<strong>今の進行と置き換え</strong>、
          <strong>長押しして上のドロップ先に離すと末尾に追加</strong>します。
          <br />
          プリセットはキーに依存しません。読み込んだあとにキーを変えれば、そのまま移調されます。
        </p>
      </section>

      <Support />

      <footer className="footer">
        音源はブラウザの Web Audio API で合成しています。MP3 のエンコードも端末内で行われ、
        音声データがどこかへ送信されることはありません。
      </footer>

      {/* プリセットを掴んでいる間だけ出る、常に手の届くドロップ先 */}
      {draggedPreset && (
        <>
          <div
            ref={dropZoneRef}
            className={`drop-zone${presetDrag.overTarget ? " over" : ""}`}
            aria-hidden="true"
          >
            <strong>{draggedPreset.name}</strong>
            <span>
              {presetDrag.overTarget
                ? "指を離すと進行の末尾に追加します"
                : "ここに持ってきて指を離すと追加"}
            </span>
          </div>
          <div className="drag-ghost" ref={presetDrag.ghostRef} aria-hidden="true">
            {draggedPreset.name}
          </div>
        </>
      )}

      {toast && (
        <div className="toast" role="status">
          <span className="toast-text">{toast}</span>
          <button
            className="btn small primary"
            onClick={() => {
              history.undo();
              setToast(null);
            }}
            disabled={!history.canUndo}
          >
            ↶ 元に戻す
          </button>
          <button
            className="btn small ghost"
            onClick={() => setToast(null)}
            aria-label="通知を閉じる"
          >
            ✕
          </button>
        </div>
      )}

      <FloatingTransport
        watch={transportRef}
        playing={playing}
        disabled={song.chords.length === 0}
        exportBusy={exportBusy}
        nowPlaying={
          playing && activeChord !== null ? (resolved[activeChord]?.name ?? null) : null
        }
        position={
          playing && activeChord !== null
            ? { index: activeChord + 1, total: resolved.length }
            : null
        }
        onToggle={() => void handlePlay()}
        onExport={() => void doExport("mp3")}
        canUndo={history.canUndo}
        onUndo={() => {
          history.undo();
          setToast(null);
        }}
      />
    </div>
  );
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function formatDuration(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = seconds - m * 60;
  return m > 0 ? `${m}分${s.toFixed(1)}秒` : `${s.toFixed(1)}秒`;
}

function describeError(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}
