/**
 * メロディを打ち込むピアノロール。
 *
 * 縦が音の高さ、横が時間。マスをタップで置く・もう一度タップで消す。
 * 同じ高さを隣に続けて置くと1つの長い音になる（音符の長さを別UIなしで指定できる）。
 *
 * マスの数は数千になりうるので、1マスずつにハンドラを付けず、
 * グリッド全体で1つのクリックを受けて data 属性から位置を読む。
 */

import { useMemo, useRef } from "react";

import { chordIndexAtStep, resolveSteps, type PitchRow, type Step } from "../music/melody";
import { mod12, prettyAccidentals } from "../music/notes";
import type { ResolvedChord } from "../music/song";

interface Props {
  rows: PitchRow[];
  steps: Step[];
  stepsPerBeat: number;
  beatsPerBar: number;
  chords: ResolvedChord[];
  /** 再生中に光らせるステップ。停止中は null。 */
  playingStep: number | null;
  onToggle: (stepIndex: number, offset: number) => void;
  /** 行の音名をタップしたときに、その高さを鳴らす。 */
  onPreviewRow: (offset: number) => void;
  /** 目盛りをタップしたとき、その拍から再生する。 */
  onSeek: (beat: number) => void;
}

export function MelodyGrid({
  rows,
  steps,
  stepsPerBeat,
  beatsPerBar,
  chords,
  playingStep,
  onToggle,
  onPreviewRow,
  onSeek,
}: Props) {
  const gridRef = useRef<HTMLDivElement>(null);

  /** 各マスで実際に鳴っている音。伸ばしの印はここで解決する。 */
  const resolved = useMemo(() => resolveSteps(steps), [steps]);

  /** 各ステップが乗っているコードの構成音（ピッチクラス）。 */
  const chordTones = useMemo(() => {
    const starts = chords.map((c) => ({ startBeat: c.startBeat, beats: c.beats }));
    return steps.map((_, i) => {
      if (starts.length === 0) return null;
      const chord = chords[chordIndexAtStep(i, stepsPerBeat, starts)];
      return chord ? new Set(chord.pitchClasses) : null;
    });
  }, [chords, steps, stepsPerBeat]);

  /** 小節の先頭にあたるステップ。区切り線を引くのに使う。 */
  const stepsPerBar = beatsPerBar * stepsPerBeat;

  const handleClick = (e: React.MouseEvent) => {
    const cell = (e.target as HTMLElement).closest<HTMLElement>("[data-step]");
    if (!cell || !gridRef.current?.contains(cell)) return;
    const step = Number(cell.dataset.step);
    const offset = Number(cell.dataset.offset);
    if (Number.isFinite(step) && Number.isFinite(offset)) onToggle(step, offset);
  };

  if (steps.length === 0) {
    return <p className="hint">進行が空です。コードを追加するとメロディを打ち込めます。</p>;
  }

  return (
    <div className="roll-wrap">
      <div className="roll-scroll">
        <div className="roll" ref={gridRef} onClick={handleClick}>
          {/* 目盛り。タップした位置から再生できるので、長い曲でも頭から聴き直さずに済む。 */}
          <div className="roll-row roll-ruler">
            <div className="roll-label ruler-label" aria-hidden="true">
              ▶
            </div>
            <div className="roll-cells">
              {steps.map((_, i) => (
                <button
                  key={i}
                  type="button"
                  className={[
                    "roll-tick",
                    i % stepsPerBar === 0 ? "bar" : "",
                    i % stepsPerBeat === 0 ? "beat" : "",
                    playingStep === i ? "playing" : "",
                  ]
                    .filter(Boolean)
                    .join(" ")}
                  onClick={() => onSeek(i / stepsPerBeat)}
                  title={`${Math.floor(i / stepsPerBar) + 1}小節目から再生`}
                >
                  {i % stepsPerBar === 0 ? Math.floor(i / stepsPerBar) + 1 : ""}
                </button>
              ))}
            </div>
          </div>

          {rows.map((row) => (
            <div key={row.offset} className="roll-row">
              <button
                className={`roll-label${row.isTonic ? " tonic" : ""}${row.inScale ? "" : " out"}`}
                onClick={() => onPreviewRow(row.offset)}
                title={`${row.name} を鳴らす`}
              >
                {prettyAccidentals(row.name)}
              </button>

              <div className="roll-cells">
                {steps.map((_, i) => {
                  const r = resolved[i];
                  const on = r.offset === row.offset;
                  // 伸ばしている途中は、つながって見えるようにする
                  const continued = on && r.held;
                  // 直前と同じ高さで打ち直している音は、切れ目を見せる
                  const restruck = on && !r.held && resolved[i - 1]?.offset === row.offset;
                  const tones = chordTones[i];
                  const isChordTone = tones?.has(mod12(row.offset)) ?? false;
                  const classes = [
                    "roll-cell",
                    on ? "on" : "",
                    continued ? "cont" : "",
                    restruck ? "restruck" : "",
                    isChordTone ? "chord-tone" : "",
                    row.inScale ? "" : "out",
                    i % stepsPerBar === 0 ? "bar" : "",
                    i % stepsPerBeat === 0 ? "beat" : "",
                    playingStep === i ? "playing" : "",
                  ]
                    .filter(Boolean)
                    .join(" ");
                  return <div key={i} className={classes} data-step={i} data-offset={row.offset} />;
                })}
              </div>
            </div>
          ))}
        </div>
      </div>

      <p className="hint roll-legend">
        マスをタップで音を置く／もう一度で消す。
        音のすぐ右をタップすると<strong>音が伸び</strong>、もう一度タップすると
        <strong>打ち直し</strong>（同じ音を続けて鳴らす）になります。
        <span className="legend-swatch chord-tone" /> は今のコードに含まれる音（合いやすい音）、
        左の音名をタップするとその高さを鳴らせます。
        <strong>上の目盛りをタップすると、そこから再生</strong>できます。
      </p>
    </div>
  );
}
