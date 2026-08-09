/**
 * ダンス動画のページ。
 *
 * コード進行のページとは HTML から分かれている。曲データは localStorage 越しに
 * 引き継がれ、リンクをたどってきたときは URL ハッシュからも読める。
 *
 * ここが持つのは「どの曲に振りを付けるか」と試聴だけで、振り付けそのものは
 * DanceStudio と dance/ 以下が受け持つ。
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { Player } from "./audio/player";
import { DanceStudio } from "./components/DanceStudio";
import type { DanceSettings } from "./dance/choreo";
import { pcName } from "./music/notes";
import { SCALES } from "./music/scales";
import {
  buildArrangement,
  resolveChords,
  totalBars,
  useFlatsForSong,
  type Song,
} from "./music/song";
import { CHORD_PAGE, pageUrl } from "./pages";
import { loadSong, loadStoredSong, saveSong } from "./state";

export default function DanceApp() {
  const [song, setSong] = useState<Song>(() => loadSong());
  const [playing, setPlaying] = useState(false);
  /** 再生中のループ内の拍位置。プレビューを音に合わせるのに使う。 */
  const [playPosition, setPlayPosition] = useState<number | null>(null);
  const [note, setNote] = useState<string | null>(null);

  const playerRef = useRef<Player | null>(null);
  const player = (): Player => {
    if (!playerRef.current) {
      const p = new Player();
      p.onEnded = () => {
        setPlaying(false);
        setPlayPosition(null);
      };
      playerRef.current = p;
    }
    return playerRef.current;
  };

  const arrangement = useMemo(() => buildArrangement(song), [song]);
  const chordNames = useMemo(() => resolveChords(song).map((c) => c.name), [song]);

  // 保存（スライダー操作中の連続書き込みを避けるため少し待つ）
  useEffect(() => {
    const t = window.setTimeout(() => saveSong(song), 400);
    return () => window.clearTimeout(t);
  }, [song]);

  // 再生位置の取り出し
  useEffect(() => {
    if (!playing) return;
    let raf = 0;
    const tick = () => {
      const pos = playerRef.current?.position();
      setPlayPosition(pos ? pos.beat : null);
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [playing]);

  // 画面を離れるときは音を止める
  useEffect(() => () => playerRef.current?.stop(), []);

  useEffect(() => {
    if (!note) return;
    const t = window.setTimeout(() => setNote(null), 6000);
    return () => window.clearTimeout(t);
  }, [note]);

  const handlePlay = async () => {
    const p = player();
    if (playing) {
      p.stop();
      setPlaying(false);
      setPlayPosition(null);
      return;
    }
    if (song.chords.length === 0) return;
    setPlaying(true);
    try {
      // 振り付けを繰り返し見たいので、このページの試聴は常にループ
      await p.play(song, true);
    } catch (err) {
      setPlaying(false);
      setNote(`再生を開始できませんでした: ${err instanceof Error ? err.message : String(err)}`);
    }
  };

  /**
   * コード進行のページで直した内容を取り込む。
   * 振り付けの設定は今の画面のものを残す（進行だけ差し替える）。
   */
  const reloadProgression = useCallback(() => {
    const latest = loadStoredSong();
    if (!latest) {
      setNote("保存された進行が見つかりませんでした。");
      return;
    }
    playerRef.current?.stop();
    setPlaying(false);
    setPlayPosition(null);
    setSong((current) => ({ ...latest, dance: current.dance }));
    setNote("コード進行を読み直しました。振り付けの設定はそのままです。");
  }, []);

  const handleDanceChange = useCallback((dance: DanceSettings) => {
    setSong((current) => ({ ...current, dance }));
  }, []);

  const keyName = `${pcName(song.tonic, useFlatsForSong(song))} ${
    SCALES.find((s) => s.id === song.scale)?.label ?? song.scale
  }`;

  return (
    <div className="app">
      <header className="header">
        <div>
          <h1>💃 ダンス動画</h1>
          <p className="sub">
            コード進行に合わせた振り付けを組み立てて、踊る動画を書き出します。
          </p>
          <p className="sub">
            <a className="page-link" href={pageUrl(CHORD_PAGE, song)}>
              ← コード進行を作る・直す
            </a>
          </p>
        </div>
      </header>

      <section className="panel">
        <h2>この曲に振りを付けます</h2>
        {song.chords.length === 0 ? (
          <p className="hint">
            コードが1つも入っていません。
            <a className="page-link" href={CHORD_PAGE}>
              コード進行のページ
            </a>
            で進行を作ってから戻ってきてください。
          </p>
        ) : (
          <>
            <div className="song-summary">
              <span className="song-summary-key">{keyName}</span>
              <span>{song.bpm} BPM</span>
              <span>{totalBars(song)} 小節</span>
              <span className="song-summary-chords">{chordNames.join(" – ")}</span>
            </div>
            <div className="row">
              <button className="btn primary" onClick={handlePlay}>
                {playing ? "■ 停止" : "▶ 試聴（ループ）"}
              </button>
              <button className="btn" onClick={reloadProgression}>
                ⟳ 進行を読み直す
              </button>
            </div>
            <p className="hint">
              再生すると、プレビューのマネキンが音に合わせて動きます。
              別のタブでコード進行を直したら「進行を読み直す」で取り込めます。
            </p>
          </>
        )}
        {note && <p className="hint">{note}</p>}
      </section>

      {song.chords.length > 0 && (
        <DanceStudio
          song={song}
          onChange={handleDanceChange}
          playPosition={playPosition}
          beatsPerLoop={arrangement.beatsPerLoop}
        />
      )}
    </div>
  );
}
