/**
 * MediaRecorder を使って、ブラウザ内蔵のエンコーダで音声ファイルを作る。
 *
 * なぜ lamejs の MP3 ではなくこれが必要か:
 * 埋め込み表示（iframe）の中では通常のダウンロードが塞がれるため、Artifact
 * ランタイムの保存機能を通すしかない。ところがそこで許可される音声の拡張子は
 * mp4 / webm だけで、mp3 も wav も渡せない。
 *
 * MediaRecorder なら Safari では AAC 入り MP4、Chrome では Opus 入り WebM を
 * 作れる。どちらも許可されている形式で、自前でコンテナを書く必要もない。
 *
 * 代償として録音は実時間かかる（40秒の曲なら40秒）。オフラインレンダリングは
 * 一瞬で終わるので、そこは今までどおり OfflineAudioContext で作ってから、
 * できた音を無音のまま流し込んで録る。
 */

export type MediaExtension = "mp4" | "webm";

export interface RecorderFormat {
  mime: string;
  extension: MediaExtension;
  /** UI に出す形式名。 */
  label: string;
}

/**
 * 優先順に試す形式。
 * MP4（AAC）を最優先にしているのは、iPhone の「ファイル」アプリと
 * ミュージックアプリがそのまま再生できるため。
 */
const CANDIDATES: RecorderFormat[] = [
  // AAC を明示的に要求する。Safari はこれを受け付ける。
  { mime: 'audio/mp4;codecs="mp4a.40.2"', extension: "mp4", label: "MP4" },
  // 指定なしの MP4。ブラウザ任せなので中身は AAC とは限らない
  // （Chromium は Opus を入れてくる）。実際のコーデックは録音後に判定する。
  { mime: "audio/mp4", extension: "mp4", label: "MP4" },
  { mime: "audio/webm;codecs=opus", extension: "webm", label: "WebM（Opus）" },
  { mime: "audio/webm", extension: "webm", label: "WebM" },
];

/** この端末で使える録音形式。使えなければ null。 */
export function pickRecorderFormat(): RecorderFormat | null {
  if (typeof MediaRecorder === "undefined") return null;
  for (const candidate of CANDIDATES) {
    try {
      if (MediaRecorder.isTypeSupported(candidate.mime)) return candidate;
    } catch {
      // isTypeSupported が例外を投げる実装もあるので次の候補へ
    }
  }
  return null;
}

export interface RecordResult {
  blob: Blob;
  format: RecorderFormat;
  /** 実際に入っていたコーデック名（"AAC" / "Opus" など）。判定できなければ null。 */
  codec: string | null;
  /**
   * AAC 入りの MP4 か。
   * これが true なら中身は .m4a と同一なので、拡張子を変えるだけで
   * m4a を要求するサービス（Suno など）に渡せる。
   */
  isAacMp4: boolean;
}

/** MP4 のサンプルエントリ（コーデック）の FourCC を読み出す。 */
export function readMp4SampleEntry(bytes: Uint8Array): string | null {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const fourcc = (at: number) =>
    String.fromCharCode(bytes[at], bytes[at + 1], bytes[at + 2], bytes[at + 3]);

  // 中を辿る必要があるコンテナボックス
  const containers = new Set(["moov", "trak", "mdia", "minf", "stbl"]);

  const scan = (start: number, end: number): string | null => {
    let off = start;
    while (off + 8 <= end) {
      const size = view.getUint32(off);
      const type = fourcc(off + 4);
      const boxEnd = size === 0 ? end : off + size;
      if (size < 8 || boxEnd > end) return null;

      if (type === "stsd") {
        // version/flags(4) + entry_count(4) を飛ばすとサンプルエントリ
        const entry = off + 16;
        if (entry + 8 <= boxEnd) return fourcc(entry + 4);
        return null;
      }
      if (containers.has(type)) {
        const hit = scan(off + 8, boxEnd);
        if (hit) return hit;
      }
      off = boxEnd;
    }
    return null;
  };

  return scan(0, bytes.byteLength);
}

/**
 * 出来上がったファイルに実際に入っているコーデックを調べる。
 *
 * MediaRecorder に "audio/mp4" を頼んでも、ブラウザが AAC を入れるとは限らない
 * （Chromium は Opus を入れる）。推測で「AACです」と言わないために実物を見る。
 */
async function inspectCodec(
  blob: Blob,
  format: RecorderFormat,
): Promise<{ codec: string | null; isAacMp4: boolean }> {
  if (format.extension !== "mp4") {
    return { codec: format.mime.includes("opus") ? "Opus" : null, isAacMp4: false };
  }
  try {
    // fragmented MP4 は moov が先頭付近にあるので、冒頭だけ読めば足りる
    const head = new Uint8Array(await blob.slice(0, 64 * 1024).arrayBuffer());
    const entry = readMp4SampleEntry(head);
    if (entry === "mp4a") return { codec: "AAC", isAacMp4: true };
    if (entry === "Opus" || entry === "opus") return { codec: "Opus", isAacMp4: false };
    return { codec: entry, isAacMp4: false };
  } catch {
    return { codec: null, isAacMp4: false };
  }
}

/**
 * レンダリング済みの AudioBuffer を録音してファイルにする。
 *
 * ctx はユーザー操作で resume 済みの AudioContext を渡すこと
 * （iOS は操作を伴わないと音声処理が始まらない）。
 */
export async function recordBuffer(
  ctx: AudioContext,
  buffer: AudioBuffer,
  onProgress?: (ratio: number) => void,
): Promise<RecordResult> {
  const format = pickRecorderFormat();
  if (!format) {
    throw new Error("このブラウザは音声ファイルの作成（MediaRecorder）に対応していません。");
  }

  const destination = ctx.createMediaStreamDestination();
  const source = ctx.createBufferSource();
  source.buffer = buffer;
  // スピーカーには繋がない。録音中に音が鳴らないようにするため。
  source.connect(destination);

  const recorder = new MediaRecorder(destination.stream, { mimeType: format.mime });
  const chunks: Blob[] = [];
  recorder.ondataavailable = (e) => {
    if (e.data.size > 0) chunks.push(e.data);
  };

  const stopped = new Promise<void>((resolve, reject) => {
    recorder.onstop = () => resolve();
    recorder.onerror = () => reject(new Error("録音中にエラーが発生しました。"));
  });

  const startedAt = ctx.currentTime;
  recorder.start(250);
  source.start();

  let progressTimer = 0;
  if (onProgress) {
    onProgress(0);
    progressTimer = window.setInterval(() => {
      const ratio = (ctx.currentTime - startedAt) / buffer.duration;
      onProgress(Math.max(0, Math.min(0.999, ratio)));
    }, 200);
  }

  // 再生の終了を待つ。タブが裏に回って AudioContext が止まると onended が
  // 来ないことがあるので、余裕を持った上限で打ち切る。
  const safetyMs = (buffer.duration * 1.5 + 10) * 1000;
  await Promise.race([
    new Promise<void>((resolve) => {
      source.onended = () => resolve();
    }),
    new Promise<void>((resolve) => window.setTimeout(resolve, safetyMs)),
  ]);

  // 末尾の余韻が切れないよう、少し待ってから止める
  await new Promise((resolve) => window.setTimeout(resolve, 300));
  recorder.stop();
  await stopped;

  window.clearInterval(progressTimer);
  onProgress?.(1);
  source.disconnect();

  const blob = new Blob(chunks, { type: format.mime });
  const { codec, isAacMp4 } = await inspectCodec(blob, format);
  return { blob, format, codec, isAacMp4 };
}
