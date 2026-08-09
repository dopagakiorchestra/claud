/**
 * 音源の性質のテスト。
 *
 * 「良い音かどうか」は測れないが、良い音であるために満たしているべき
 * 性質は測れる。ここでは音を実際に描画せず、音源が組み立てるノードの
 * 構成と、そこに設定される値を記録して確かめる。
 */

import { describe, expect, it } from "vitest";

import { INSTRUMENTS, bassInstrument, getInstrument, playDrum } from "../src/audio/instruments";

interface Recorded {
  oscillators: Array<{ type: string; freq: number; detune: number }>;
  pans: number[];
  nodes: number;
  /**
   * ゲインに予約された値を、設定された順に全部。
   *
   * 音量のエンベロープに混じって、変調の深さ（周波数そのものの大きさ）や
   * 声部の混ぜ具合も入ってくる。どれが音量かは外から見分けられないので、
   * 「同じ順で並ぶ2つを突き合わせる」形で使う。組み立ての順序は決定的。
   */
  gains: number[];
  /** バンドパス等のフィルタに設定された周波数。 */
  filterFreqs: number[];
}

/**
 * Web Audio のノードを最低限だけ真似た偽コンテキスト。
 * 音源は「ノードを作って繋いで値を予約する」だけなので、これで足りる。
 */
function fakeCtx(): { ctx: BaseAudioContext; rec: Recorded } {
  const rec: Recorded = { oscillators: [], pans: [], nodes: 0, gains: [], filterFreqs: [] };

  const param = (track?: (v: number) => void) => {
    const p = {
      _value: 0,
      get value() {
        return this._value;
      },
      set value(v: number) {
        this._value = v;
        track?.(v);
      },
      setValueAtTime: (v: number) => (track?.(v), p),
      linearRampToValueAtTime: (v: number) => (track?.(v), p),
      exponentialRampToValueAtTime: (v: number) => (track?.(v), p),
      cancelScheduledValues: () => p,
    };
    return p;
  };

  const node = () => ({
    connect: (d: unknown) => d,
    disconnect: () => {},
  });

  const ctx = {
    sampleRate: 44100,
    createGain: () => {
      rec.nodes++;
      return { ...node(), gain: param((v) => rec.gains.push(v)) };
    },
    createOscillator: () => {
      rec.nodes++;
      const o = {
        ...node(),
        type: "sine",
        frequency: param(),
        detune: param(),
        start: () => {},
        stop: () => {},
      };
      // start されたものだけを記録したいので、start 時に確定させる
      o.start = () => {
        rec.oscillators.push({ type: o.type, freq: o.frequency.value, detune: o.detune.value });
      };
      return o;
    },
    createBiquadFilter: () => {
      rec.nodes++;
      return {
        ...node(),
        type: "lowpass",
        frequency: param((v) => rec.filterFreqs.push(v)),
        Q: param(),
        gain: param(),
      };
    },
    createStereoPanner: () => {
      rec.nodes++;
      return { ...node(), pan: param((v) => rec.pans.push(v)) };
    },
    createBufferSource: () => {
      rec.nodes++;
      return { ...node(), buffer: null, start: () => {}, stop: () => {} };
    },
    createWaveShaper: () => {
      rec.nodes++;
      return { ...node(), curve: null, oversample: "none" };
    },
    createBuffer: (ch: number, len: number) => ({
      numberOfChannels: ch,
      length: len,
      sampleRate: 44100,
      getChannelData: () => new Float32Array(len),
    }),
  } as unknown as BaseAudioContext;

  return { ctx, rec };
}

/** 1音鳴らして、組み立てられた内容を返す。 */
function play(id: string, midi = 60, vel = 0.8, dur = 0.5): Recorded {
  const { ctx, rec } = fakeCtx();
  const dest = ctx.createGain();
  rec.nodes = 0;
  rec.gains.length = 0;
  if (id === "bass") bassInstrument.play(ctx, dest, midi, 0, dur, vel);
  else getInstrument(id).play(ctx, dest, midi, 0, dur, vel);
  return rec;
}

describe("すべての音色", () => {
  const ids = INSTRUMENTS.map((i) => i.id);

  it.each(ids)("%s は音を出す", (id) => {
    const r = play(id);
    expect(r.oscillators.length).toBeGreaterThan(0);
    expect(Math.max(...r.gains)).toBeGreaterThan(0);
  });

  it.each(ids)("%s は強く弾くほど大きい", (id) => {
    // 組み立ての順序は決まっているので、同じ位置どうしを突き合わせる。
    // どれか1つでも上がり、どれも下がらないことを見る。
    const soft = play(id, 60, 0.3).gains;
    const hard = play(id, 60, 1.0).gains;
    expect(hard).toHaveLength(soft.length);
    let raised = 0;
    for (let i = 0; i < soft.length; i++) {
      expect(hard[i]).toBeGreaterThanOrEqual(soft[i] - 1e-9);
      if (hard[i] > soft[i] + 1e-9) raised++;
    }
    expect(raised).toBeGreaterThan(0);
  });

  it.each(ids)("%s は強さ0なら鳴らない", (id) => {
    const zero = play(id, 60, 0).gains;
    const loud = play(id, 60, 1).gains;
    // 強さで変わるゲインは、強さ0では実質ゼロまで落ちる
    for (let i = 0; i < zero.length; i++) {
      if (loud[i] > zero[i] + 1e-9) expect(zero[i]).toBeLessThanOrEqual(0.001);
    }
  });

  it.each(ids)("%s は音程が上がると周波数も上がる", (id) => {
    const low = play(id, 48).oscillators.map((o) => o.freq);
    const high = play(id, 72).oscillators.map((o) => o.freq);
    // 基音（最低の発振器）で比べる。LFO は音程に依らないので除く。
    const base = (fs: number[]) => Math.min(...fs.filter((f) => f > 20));
    expect(base(high)).toBeGreaterThan(base(low));
  });

  it.each(ids)("%s は同じ入力なら同じ組み立てになる", (id) => {
    expect(play(id, 64, 0.7)).toEqual(play(id, 64, 0.7));
  });
});

describe("強さで音色が変わる", () => {
  /** 基音より十分高い成分の数。明るさの目安。 */
  const highCount = (id: string, vel: number) => {
    const r = play(id, 60, vel);
    const base = Math.min(...r.oscillators.map((o) => o.freq).filter((f) => f > 20));
    return r.oscillators.filter((o) => o.freq > base * 3).length;
  };

  it("ピアノは弱く弾くと高い倍音が減る", () => {
    expect(highCount("piano", 1.0)).toBeGreaterThan(highCount("piano", 0.2));
  });

  it("エレピは強く弾くほど金属的な成分が強くなる", () => {
    // FM の深さは強さの2乗で効く。強さを2倍にすると、音量は2倍でも
    // 変調の深さは4倍になる。いちばん大きいゲイン＝変調の深さで見る。
    const depth = (vel: number) => Math.max(...play("epiano", 60, vel).gains);
    expect(depth(0.8) / depth(0.4)).toBeGreaterThan(3.5);
  });

  it("ギターは強く弾くほどフィルタが開く", () => {
    const open = (vel: number) => Math.max(...play("pluck", 60, vel).filterFreqs);
    expect(open(1.0)).toBeGreaterThan(open(0.3));
  });
});

describe("左右の広がり", () => {
  it("重ねる音色は左右に散っている", () => {
    for (const id of ["pad", "strings"]) {
      const pans = play(id).pans.filter((p) => p !== 0);
      expect(pans.length, `${id} が広がっていない`).toBeGreaterThan(0);
    }
  });

  it("オルガンは左右に揺れる", () => {
    // ロータリーは位置そのものを揺らすので、初期値は真ん中のまま。
    // パンナーが在ることと、揺れ幅のゲインが用意されていることで見る。
    const r = play("organ");
    expect(r.pans.length).toBeGreaterThan(0);
    expect(r.gains.some((g) => g > 0.2 && g < 1)).toBe(true);
  });

  it("1音につきパンナーは作りすぎない", () => {
    // 声部ごとに作ると音数に比例して重くなるので、数を抑えている
    for (const id of INSTRUMENTS.map((i) => i.id)) {
      expect(play(id).pans.length, `${id} のパンナーが多い`).toBeLessThanOrEqual(3);
    }
  });

  it("広げても左右に振り切らない", () => {
    for (const id of INSTRUMENTS.map((i) => i.id)) {
      for (const p of play(id).pans) expect(Math.abs(p)).toBeLessThanOrEqual(0.8);
    }
  });
});

describe("ピアノの弦らしさ", () => {
  it("倍音が整数倍からわずかに上にずれている", () => {
    const freqs = play("piano", 60)
      .oscillators.map((o) => o.freq)
      .sort((a, b) => a - b);
    const base = freqs[0];
    // 2倍音は 2*base よりわずかに高い（弦の硬さぶん）
    const second = freqs.find((f) => f > base * 1.9 && f < base * 2.2)!;
    expect(second).toBeGreaterThan(base * 2);
    expect(second).toBeLessThan(base * 2.02);
  });

  it("低い音ほどずれが大きい", () => {
    const stretch = (midi: number) => {
      const f = play("piano", midi)
        .oscillators.map((o) => o.freq)
        .sort((a, b) => a - b);
      return f.find((x) => x > f[0] * 1.9 && x < f[0] * 2.2)! / (f[0] * 2);
    };
    expect(stretch(36)).toBeGreaterThan(stretch(84));
  });
});

describe("ドラム", () => {
  const hit = (voice: "kick" | "snare" | "hat" | "ride", vel = 0.9): Recorded => {
    const { ctx, rec } = fakeCtx();
    const dest = ctx.createGain();
    rec.nodes = 0;
    rec.gains.length = 0;
    playDrum(ctx, dest, voice, 0, vel);
    return rec;
  };

  it.each(["kick", "snare", "hat", "ride"] as const)("%s は音を出す", (v) => {
    expect(Math.max(...hit(v).gains)).toBeGreaterThan(0);
  });

  it.each(["kick", "snare", "hat", "ride"] as const)("%s は強さで音量が変わる", (v) => {
    expect(Math.max(...hit(v, 1.0).gains)).toBeGreaterThan(Math.max(...hit(v, 0.3).gains));
  });

  it("キックは低い音まで落ちる", () => {
    const freqs = hit("kick").oscillators.map((o) => o.freq);
    expect(Math.min(...freqs)).toBeLessThan(200);
  });

  it("シンバル類は左右に置かれている", () => {
    expect(hit("hat").pans.some((p) => p !== 0)).toBe(true);
    expect(hit("ride").pans.some((p) => p !== 0)).toBe(true);
  });

  it("キックは真ん中から動かさない", () => {
    // 低音を左右に振ると芯がぼやける
    expect(hit("kick").pans.filter((p) => p !== 0)).toHaveLength(0);
  });
});

describe("ベース", () => {
  it("倍音を足すために歪ませている", () => {
    const { ctx, rec } = fakeCtx();
    let shapers = 0;
    const orig = ctx.createWaveShaper.bind(ctx);
    (ctx as { createWaveShaper: () => unknown }).createWaveShaper = () => (shapers++, orig());
    bassInstrument.play(ctx, ctx.createGain(), 40, 0, 0.5, 0.8);
    expect(shapers).toBe(1);
    expect(rec.oscillators.length).toBeGreaterThan(0);
  });

  it("真ん中から動かさない", () => {
    expect(play("bass", 40).pans.filter((p) => p !== 0)).toHaveLength(0);
  });
});
