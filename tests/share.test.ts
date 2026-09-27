/**
 * 保存のときに何を共有シートへ渡しているかのテスト。
 *
 * iOS は title や text を添えると、それを別の共有項目として扱う。
 * 「"ファイル"に保存」したときに、音声ファイルとは別にテキストまで
 * 保存されてしまうので、渡すのはファイルだけにしておく。
 */

import { afterEach, describe, expect, it, vi } from "vitest";

import { saveBlob } from "../src/audio/export";

const IPHONE_UA =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1";

interface Shared {
  files?: unknown[];
  [key: string]: unknown;
}

/** 共有シートを差し替えて、渡された中身を記録する。 */
function stubShare(opts: { ua?: string; reject?: unknown } = {}) {
  const calls: Shared[] = [];
  const nav = {
    userAgent: opts.ua ?? IPHONE_UA,
    share: vi.fn(async (data: Shared) => {
      calls.push(data);
      if (opts.reject) throw opts.reject;
    }),
    canShare: vi.fn(() => true),
  };
  vi.stubGlobal("navigator", nav);
  // File は node にもあるが、共有の判定で使うので念のため用意しておく
  if (typeof globalThis.File === "undefined") {
    vi.stubGlobal(
      "File",
      class {
        constructor(
          public parts: unknown[],
          public name: string,
          public opts: { type?: string } = {},
        ) {}
        get type() {
          return this.opts.type ?? "";
        }
      },
    );
  }
  return { calls, nav };
}

afterEach(() => vi.unstubAllGlobals());

const mp3 = () => new Blob([new Uint8Array([1, 2, 3])], { type: "audio/mpeg" });

describe("共有シートに渡す中身", () => {
  it("ファイルだけを渡す", async () => {
    const { calls } = stubShare();
    const outcome = await saveBlob(mp3(), "song.mp3");
    expect(outcome).toBe("shared");
    expect(calls).toHaveLength(1);
    expect(Object.keys(calls[0])).toEqual(["files"]);
  });

  it("title を渡さない（テキストが一緒に保存される原因）", async () => {
    const { calls } = stubShare();
    await saveBlob(mp3(), "song.mp3");
    expect(calls[0].title).toBeUndefined();
  });

  it("text も url も渡さない", async () => {
    const { calls } = stubShare();
    await saveBlob(mp3(), "song.mp3");
    expect(calls[0].text).toBeUndefined();
    expect(calls[0].url).toBeUndefined();
  });

  it("渡すファイルは1つだけ", async () => {
    const { calls } = stubShare();
    await saveBlob(mp3(), "song.mp3");
    expect(calls[0].files).toHaveLength(1);
  });

  it("ファイル名と種類は保たれる", async () => {
    const { calls } = stubShare();
    await saveBlob(mp3(), "わたしの曲.mp3");
    const file = (calls[0].files as Array<{ name: string; type: string }>)[0];
    expect(file.name).toBe("わたしの曲.mp3");
    expect(file.type).toBe("audio/mpeg");
  });

  it("WAV でも同じ", async () => {
    const { calls } = stubShare();
    await saveBlob(new Blob([new Uint8Array([0])], { type: "audio/wav" }), "song.wav");
    expect(Object.keys(calls[0])).toEqual(["files"]);
  });
});

describe("共有を閉じたとき", () => {
  it("ユーザーが閉じただけならエラーにしない", async () => {
    const abort = Object.assign(new Error("share cancelled"), { name: "AbortError" });
    stubShare({ reject: abort });
    expect(await saveBlob(mp3(), "song.mp3")).toBe("cancelled");
  });
});
