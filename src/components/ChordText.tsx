/**
 * コード進行をテキストから読み込む欄。
 *
 * 外で見つけた進行をそのまま貼れるようにするためのもの。
 * 読み込む前に「どう解釈されたか」を出して、取り違えに気づけるようにする。
 */

import { useMemo, useState } from "react";

import { parseProgression } from "../music/parseChords";
import { prettyAccidentals } from "../music/notes";
import { resolveChords, type ChordSlot, type Song } from "../music/song";

interface Props {
  song: Song;
  /** 読み込んだ進行を反映する。 */
  onApply: (chords: ChordSlot[], mode: "replace" | "append") => void;
}

const PLACEHOLDER = "Fm11 | B7alt | Emaj9(#11) | A13(b9)\nDm9 | G7(#5#9) | Cm11 | C7alt";

export function ChordText({ song, onApply }: Props) {
  const [text, setText] = useState("");

  const parsed = useMemo(
    () => parseProgression(text, song.tonic, song.beatsPerBar),
    [text, song.tonic, song.beatsPerBar],
  );

  /** 読み取れたコードが実際にどう表示されるか。 */
  const preview = useMemo(() => {
    const slots = parsed.chords.flatMap((c) => (c.slot ? [c.slot] : []));
    if (slots.length === 0) return [];
    return resolveChords({ ...song, chords: slots });
  }, [parsed, song]);

  const slots = () => parsed.chords.flatMap((c) => (c.slot ? [c.slot] : []));
  const unreadable = parsed.chords.filter((c) => c.slot === null);

  return (
    <section className="panel">
      <h2>テキストから読み込む</h2>

      <p className="hint">
        コード名を並べて貼り付けると、そのまま進行になります。
        <strong>縦棒か改行で小節を区切り</strong>、1小節に2つ書けば半分ずつの長さになります。
      </p>

      <textarea
        className="chord-text"
        value={text}
        onChange={(e) => setText(e.target.value)}
        placeholder={PLACEHOLDER}
        rows={3}
        spellCheck={false}
        autoCapitalize="off"
        autoCorrect="off"
        aria-label="コード進行のテキスト"
      />

      {text.trim() !== "" && (
        <div className="parse-result">
          <p className="hint">
            {parsed.ok > 0 ? (
              <>
                <strong>{parsed.ok}個</strong>読み取れました
              </>
            ) : (
              "読み取れたコードがありません"
            )}
            {parsed.failed > 0 && (
              <>
                {" / "}
                <span className="parse-bad">{parsed.failed}個は分かりません</span>
              </>
            )}
          </p>

          {preview.length > 0 && (
            <div className="parse-chips">
              {preview.map((c, i) => (
                <span key={i} className="parse-chip" title={`${c.roman} / ${c.beats}拍`}>
                  {prettyAccidentals(c.name)}
                </span>
              ))}
            </div>
          )}

          {unreadable.length > 0 && (
            <ul className="parse-errors">
              {unreadable.map((c, i) => (
                <li key={i}>
                  <code>{c.text}</code> … {c.reason}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}

      <div className="row">
        <button
          className="btn primary small"
          disabled={parsed.ok === 0}
          onClick={() => onApply(slots(), "replace")}
        >
          置き換える
        </button>
        <button
          className="btn small"
          disabled={parsed.ok === 0}
          onClick={() => onApply(slots(), "append")}
        >
          末尾に追加
        </button>
        <button className="btn small ghost" disabled={text === ""} onClick={() => setText("")}>
          消す
        </button>
      </div>

      <p className="hint">
        読み込んだあとに<strong>キーを変えると全体が移調</strong>されます。
        貼り付けたときの音のまま使いたい場合は、キーを変えずにそのままどうぞ。
      </p>
    </section>
  );
}
