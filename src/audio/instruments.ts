/**
 * Web Audio API による簡易シンセ音源。
 *
 * 外部サンプルを一切使わないので、オフラインでも即座に鳴り、
 * OfflineAudioContext での書き出しも同じコードパスで動く。
 *
 * すべての関数は「与えられた time にノードを組んでスケジュールするだけ」で、
 * ctx が AudioContext か OfflineAudioContext かを気にしない。
 */

import { midiToFreq } from "../music/notes";
import type { DrumVoice } from "../music/patterns";

const MIN_GAIN = 0.0001;

/** ホワイトノイズのバッファをコンテキストごとにキャッシュする。 */
const noiseCache = new WeakMap<BaseAudioContext, AudioBuffer>();

function noiseBuffer(ctx: BaseAudioContext): AudioBuffer {
  const cached = noiseCache.get(ctx);
  if (cached) return cached;
  const len = Math.floor(ctx.sampleRate * 1.2);
  const buf = ctx.createBuffer(1, len, ctx.sampleRate);
  const data = buf.getChannelData(0);
  // 決定論的な擬似乱数。試聴と書き出しで同じ波形になるようにしている。
  let seed = 0x2f6e2b1;
  for (let i = 0; i < len; i++) {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    data[i] = (seed / 0xffffffff) * 2 - 1;
  }
  noiseCache.set(ctx, buf);
  return buf;
}

/** 打楽器・撥弦系のエンベロープ: 立ち上がってから指数的に減衰。 */
function percEnv(
  param: AudioParam,
  t: number,
  peak: number,
  attack: number,
  decay: number,
): void {
  param.setValueAtTime(MIN_GAIN, t);
  param.linearRampToValueAtTime(peak, t + attack);
  param.exponentialRampToValueAtTime(MIN_GAIN, t + attack + decay);
}

/** 持続音のエンベロープ: A-D-S-R。 */
function adsrEnv(
  param: AudioParam,
  t: number,
  dur: number,
  peak: number,
  attack: number,
  decay: number,
  sustain: number,
  release: number,
): void {
  const sustainLevel = Math.max(MIN_GAIN, peak * sustain);
  const holdEnd = t + Math.max(attack + decay, dur);
  param.setValueAtTime(MIN_GAIN, t);
  param.linearRampToValueAtTime(peak, t + attack);
  param.exponentialRampToValueAtTime(sustainLevel, t + attack + decay);
  param.setValueAtTime(sustainLevel, holdEnd);
  param.exponentialRampToValueAtTime(MIN_GAIN, holdEnd + release);
}

export interface Instrument {
  id: string;
  label: string;
  /** この音色を単音鳴らす。 */
  play(
    ctx: BaseAudioContext,
    dest: AudioNode,
    midi: number,
    time: number,
    dur: number,
    vel: number,
  ): void;
  /** 発音後に残る余韻の長さ（秒）。書き出し長の計算に使う。 */
  tail: number;
}

/** 基本波形を1つ鳴らすだけのヘルパ。 */
function osc(
  ctx: BaseAudioContext,
  type: OscillatorType,
  freq: number,
  time: number,
  stop: number,
  detune = 0,
): OscillatorNode {
  const o = ctx.createOscillator();
  o.type = type;
  o.frequency.value = freq;
  if (detune) o.detune.value = detune;
  o.start(time);
  o.stop(stop);
  return o;
}

/**
 * 音程ごとの微小なゆらぎ。同じ音程なら必ず同じ値を返す。
 *
 * 完全に揃った音を重ねると機械的に聞こえるので、音ごとにピッチと音量を
 * ほんの少しずらす。乱数を使うと試聴と書き出しで音が変わってしまうため、
 * 音程から決まるハッシュにしている。
 */
function jitter(midi: number, salt: number): number {
  let h = (Math.round(midi) * 2654435761 + salt * 40503) >>> 0;
  h ^= h >>> 15;
  h = (h * 2246822519) >>> 0;
  h ^= h >>> 13;
  return (h / 0xffffffff) * 2 - 1;
}

/**
 * 左右に広げる。返り値に繋ぐと、その音がその位置から鳴る。
 *
 * 全部が真ん中から鳴ると団子になって、音数が増えるほど濁って聞こえる。
 * StereoPanner が無い環境では、広げずにそのまま繋ぐ。
 */
function panned(ctx: BaseAudioContext, dest: AudioNode, pan: number): AudioNode {
  if (pan === 0 || typeof ctx.createStereoPanner !== "function") return dest;
  const p = ctx.createStereoPanner();
  p.pan.value = Math.max(-1, Math.min(1, pan));
  p.connect(dest);
  return p;
}

/**
 * 1音ぶんの左右の振り分け先。
 *
 * 声部ごとにパンナーを作ると、音数に比例してノードが増えて書き出しが
 * 目に見えて遅くなる。1音につき最大2つだけ作って、各声部はそこへ流す。
 */
interface Stereo {
  left: AudioNode;
  center: AudioNode;
  right: AudioNode;
}

function stereoPair(ctx: BaseAudioContext, dest: AudioNode, width: number): Stereo {
  if (width <= 0 || typeof ctx.createStereoPanner !== "function") {
    return { left: dest, center: dest, right: dest };
  }
  return {
    left: panned(ctx, dest, -width),
    center: dest,
    right: panned(ctx, dest, width),
  };
}

/** 声部の番号から左右どちらかへ振り分ける。 */
function side(st: Stereo, i: number): AudioNode {
  return i % 2 === 0 ? st.left : st.right;
}

/**
 * 強さから明るさへの係数。
 *
 * 本物の楽器は強く鳴らすほど高い倍音が増える。音量だけを変えても
 * 「小さい音」にしかならず、「やさしく弾いた音」にはならない。
 */
function velBright(vel: number): number {
  return 0.5 + vel * 0.75;
}

/**
 * 弦の非調和性。倍音を少しずつ上にずらす。
 *
 * 実際の弦は硬さがあるので、倍音がぴったり整数倍にならず少し高くなる。
 * これがピアノらしい響きの正体で、整数倍で重ねるとオルガンっぽくなる。
 */
function stretched(freq: number, n: number, b: number): number {
  return freq * n * Math.sqrt(1 + b * n * n);
}

export const INSTRUMENTS: Instrument[] = [
  {
    id: "piano",
    label: "ピアノ",
    tail: 2.2,
    play(ctx, dest, midi, time, dur, vel) {
      const freq = midiToFreq(midi);
      const out = ctx.createGain();
      out.gain.value = 1;
      out.connect(dest);

      const decayScale = Math.max(0.45, Math.min(1.6, 1.6 - (midi - 48) / 60));
      const stop = time + Math.max(dur, 0.2) + 2.2;
      const bright = velBright(vel);
      // 低い弦ほど硬さの影響が大きく、倍音のずれも大きい
      const inharmonic = 0.0004 + Math.max(0, (60 - midi) / 60) * 0.0022;
      // 弱く弾くと高い倍音が出ない。強く弾くと上まで鳴る。
      const rolloff = 1.25 - bright * 0.55;

      // 高い倍音ほど速く減り、少しだけ左右に散る。
      // 倍音が全部同じ場所から鳴ると、板のように平たい音になる。
      const st = stereoPair(ctx, out, 0.3);
      for (let n = 1; n <= 6; n++) {
        const level = (0.55 / Math.pow(n, 1.35 + rolloff)) * vel;
        if (level < 0.002) break;
        const g = ctx.createGain();
        percEnv(g.gain, time, level, 0.003, (2.0 / Math.pow(n, 0.55)) * decayScale);
        // 低い倍音は真ん中に置いて芯を残す
        osc(ctx, "sine", stretched(freq, n, inharmonic), time, stop)
          .connect(g)
          .connect(n <= 2 ? st.center : side(st, n));
      }

      // 打鍵のノイズ成分。強く弾くほど大きく、明るくなる。
      const click = ctx.createBufferSource();
      click.buffer = noiseBuffer(ctx);
      const clickFilter = ctx.createBiquadFilter();
      clickFilter.type = "bandpass";
      clickFilter.frequency.value = Math.min(7000, freq * 5 * bright);
      clickFilter.Q.value = 0.9;
      const clickGain = ctx.createGain();
      percEnv(clickGain.gain, time, 0.05 * vel * bright, 0.001, 0.05);
      click.start(time);
      click.stop(time + 0.1);
      click.connect(clickFilter).connect(clickGain).connect(out);
    },
  },
  {
    id: "epiano",
    label: "エレピ",
    tail: 2.4,
    play(ctx, dest, midi, time, dur, vel) {
      const freq = midiToFreq(midi);
      const stop = time + Math.max(dur, 0.2) + 2.4;
      const out = ctx.createGain();
      out.connect(dest);

      // FM: モジュレータの深さを速く減衰させると鐘っぽいアタックになる。
      //
      // 深さを強さの2乗で効かせているのがこの音色の肝。エレピは弱く弾くと
      // 丸い音、強く弾くと「キン」と歯切れの良い音になる楽器で、
      // 音量だけ変えても同じ表情のまま小さくなるだけになってしまう。
      const carrier = osc(ctx, "sine", freq, time, stop);
      const mod = osc(ctx, "sine", freq * 14, time, stop);
      const modGain = ctx.createGain();
      percEnv(modGain.gain, time, freq * 3.2 * vel * vel, 0.002, 0.28);
      mod.connect(modGain).connect(carrier.frequency);

      const g = ctx.createGain();
      percEnv(g.gain, time, 0.5 * vel, 0.004, 1.9);
      carrier.connect(g).connect(out);

      const st = stereoPair(ctx, out, 0.16);

      // 金属的な鳴き。アタックだけに乗せて、伸びには残さない。
      const tine = osc(ctx, "sine", freq * 6.1, time, stop);
      const tineGain = ctx.createGain();
      percEnv(tineGain.gain, time, 0.055 * vel * vel, 0.001, 0.5);
      tine.connect(tineGain).connect(st.right);

      // 下支えの基音
      const sub = osc(ctx, "triangle", freq, time, stop);
      const subGain = ctx.createGain();
      percEnv(subGain.gain, time, 0.18 * vel, 0.006, 1.4);
      sub.connect(subGain).connect(st.left);
    },
  },
  {
    id: "pad",
    label: "パッド",
    tail: 3.0,
    play(ctx, dest, midi, time, dur, vel) {
      const freq = midiToFreq(midi);
      const stop = time + Math.max(dur, 0.3) + 3.0;
      const filter = ctx.createBiquadFilter();
      filter.type = "lowpass";
      filter.frequency.setValueAtTime(Math.min(700, freq * 2), time);
      filter.frequency.linearRampToValueAtTime(Math.min(4200, freq * 7), time + 1.2);
      filter.Q.value = 0.7;

      const g = ctx.createGain();
      // 左右に散らしたぶん厚みが増えているので、レベルは少し下げて余裕を作る
      adsrEnv(g.gain, time, dur, 0.25 * vel, 0.35, 0.6, 0.75, 1.6);
      filter.connect(g).connect(dest);

      // フィルタをゆっくり揺らして、伸ばしている間の表情を作る。
      // 動きが無いと、長く伸ばしたときに書き割りのように聞こえる。
      const sweep = osc(ctx, "sine", 0.13, time, stop);
      const sweepGain = ctx.createGain();
      sweepGain.gain.value = Math.min(900, freq * 1.6);
      sweep.connect(sweepGain).connect(filter.frequency);

      // 左右に散らして厚みを出す
      const st = stereoPair(ctx, filter, 0.6);
      const dests = [st.left, st.center, st.right];
      [-11, 0, 9].forEach((detune, i) => {
        osc(ctx, "sawtooth", freq, time, stop, detune + jitter(midi, i) * 3).connect(dests[i]);
      });
      osc(ctx, "sine", freq / 2, time, stop).connect(filter);
    },
  },
  {
    id: "organ",
    label: "オルガン",
    tail: 0.5,
    play(ctx, dest, midi, time, dur, vel) {
      const freq = midiToFreq(midi);
      const stop = time + Math.max(dur, 0.1) + 0.5;
      const out = ctx.createGain();
      adsrEnv(out.gain, time, dur, 0.34 * vel, 0.012, 0.08, 0.92, 0.12);
      out.connect(dest);

      // ロータリースピーカー。ゆっくり回る分の揺れを音程と左右の位置に付ける。
      // 揺れが無いと、倍音を足しただけの発振器の音から抜け出せない。
      const rotor = osc(ctx, "sine", 5.6, time, stop);
      const rotorPitch = ctx.createGain();
      rotorPitch.gain.value = freq * 0.004;
      rotor.connect(rotorPitch);

      let rotorPan: AudioNode = out;
      if (typeof ctx.createStereoPanner === "function") {
        const p = ctx.createStereoPanner();
        p.pan.value = 0;
        const panDepth = ctx.createGain();
        panDepth.gain.value = 0.45;
        rotor.connect(panDepth).connect(p.pan);
        p.connect(out);
        rotorPan = p;
      }

      // ドローバー風の倍音構成
      const drawbars: Array<[number, number]> = [
        [0.5, 0.3],
        [1, 1],
        [2, 0.55],
        [3, 0.28],
        [4, 0.2],
        [6, 0.12],
        [8, 0.08],
      ];
      for (const [mult, level] of drawbars) {
        const g = ctx.createGain();
        g.gain.value = level * 0.38;
        const o = osc(ctx, "sine", freq * mult, time, stop);
        // 高い倍音ほど回転の影響を受ける（低音は揺らさない）
        if (mult >= 2) rotorPitch.connect(o.frequency);
        o.connect(g).connect(rotorPan);
      }

      // キークリック。鍵を押した瞬間の「カチッ」で、輪郭がはっきりする。
      // ノイズ＋フィルタでも作れるが、1音ごとに増えるノードは軽いほどよいので、
      // 高い矩形波を一瞬だけ鳴らして代用している。
      const click = osc(ctx, "square", Math.min(5200, freq * 5), time, time + 0.05);
      const clickGain = ctx.createGain();
      percEnv(clickGain.gain, time, 0.05 * vel, 0.0005, 0.02);
      click.connect(clickGain).connect(out);
    },
  },
  {
    id: "pluck",
    label: "ギター（撥弦）",
    tail: 1.6,
    play(ctx, dest, midi, time, dur, vel) {
      const freq = midiToFreq(midi);
      const stop = time + Math.max(dur, 0.15) + 1.6;
      const bright = velBright(vel);
      const filter = ctx.createBiquadFilter();
      filter.type = "lowpass";
      // 強く弾くほど明るく開く
      filter.frequency.setValueAtTime(Math.min(10000, freq * 9 * bright), time);
      filter.frequency.exponentialRampToValueAtTime(Math.max(240, freq * 1.6), time + 0.7);
      filter.Q.value = 1.1;

      const g = ctx.createGain();
      percEnv(g.gain, time, 0.42 * vel, 0.004, 1.5);

      // 箱鳴り。胴の共鳴が無いと、ただの減衰する電子音になる。
      const body = ctx.createBiquadFilter();
      body.type = "peaking";
      body.frequency.value = 190;
      body.Q.value = 1.1;
      body.gain.value = 4.5;
      filter.connect(g).connect(body).connect(dest);

      osc(ctx, "sawtooth", freq, time, stop).connect(filter);
      const tri = ctx.createGain();
      tri.gain.value = 0.5;
      // 2本目の弦をわずかにずらす。うなりが出て弦らしくなる。
      osc(ctx, "triangle", freq, time, stop, 6 + jitter(midi, 7) * 4)
        .connect(tri)
        .connect(panned(ctx, filter, jitter(midi, 3) * 0.25));

      // 弦を弾く瞬間のノイズ
      const pick = ctx.createBufferSource();
      pick.buffer = noiseBuffer(ctx);
      const pickHp = ctx.createBiquadFilter();
      pickHp.type = "highpass";
      pickHp.frequency.value = 2000;
      const pickGain = ctx.createGain();
      percEnv(pickGain.gain, time, 0.08 * vel, 0.001, 0.04);
      pick.start(time);
      pick.stop(time + 0.08);
      pick.connect(pickHp).connect(pickGain).connect(dest);
    },
  },
  {
    id: "strings",
    label: "ストリングス",
    tail: 1.8,
    play(ctx, dest, midi, time, dur, vel) {
      const freq = midiToFreq(midi);
      const stop = time + Math.max(dur, 0.3) + 1.8;
      const filter = ctx.createBiquadFilter();
      filter.type = "lowpass";
      filter.frequency.value = Math.min(5000, freq * 8);

      const g = ctx.createGain();
      adsrEnv(g.gain, time, dur, 0.22 * vel, 0.16, 0.3, 0.85, 0.7);
      filter.connect(g).connect(dest);

      // ビブラートは少し遅れてかける。弾き始めから揺れていると電子音に聞こえる。
      const lfo = osc(ctx, "sine", 5.2, time, stop);
      const lfoGain = ctx.createGain();
      lfoGain.gain.setValueAtTime(0.0001, time);
      lfoGain.gain.setValueAtTime(0.0001, time + 0.25);
      lfoGain.gain.linearRampToValueAtTime(freq * 0.007, time + 0.9);
      lfo.connect(lfoGain);

      // 奏者ごとに音程も出だしも少しずつ違う。これが合奏の厚みになる。
      // 全員がぴったり同じだと、1台のシンセにしか聞こえない。
      const st = stereoPair(ctx, filter, 0.65);
      [-16, -5, 5, 16].forEach((detune, i) => {
        const drift = jitter(midi, i) * 4;
        const o = osc(ctx, "sawtooth", freq, time, stop, detune + drift);
        lfoGain.connect(o.frequency);
        const og = ctx.createGain();
        // 出だしをずらす（0〜35ms）
        const late = time + Math.abs(jitter(midi, i + 40)) * 0.035;
        og.gain.setValueAtTime(MIN_GAIN, time);
        og.gain.setValueAtTime(MIN_GAIN, late);
        og.gain.linearRampToValueAtTime(0.3, late + 0.12);
        o.connect(og).connect(side(st, i));
      });
    },
  },
  {
    id: "musicbox",
    label: "オルゴール",
    tail: 3.2,
    play(ctx, dest, midi, time, dur, vel) {
      const freq = midiToFreq(midi);
      const stop = time + Math.max(dur, 0.1) + 3.2;
      const out = ctx.createGain();
      out.connect(dest);
      // 倍音の比。2.76 や 5.4 のような中途半端な比を強く鳴らすと、
      // 和音に混ざったとき濁って聞こえる。基音とオクターブ・12度を主体にして、
      // 金属的な高い倍音は「カン」と鳴る一瞬だけ、ごく小さく混ぜる。
      const partials: Array<[number, number, number]> = [
        [1, 0.5, 3.0],
        [2, 0.12, 1.6],
        [3, 0.05, 0.9],
        [6.27, 0.03, 0.35],
        [9.1, 0.012, 0.2],
      ];
      const st = stereoPair(ctx, out, 0.22);
      partials.forEach(([mult, level, decay], i) => {
        const g = ctx.createGain();
        // 高い倍音は強く弾いたときだけ出る
        const amount = mult > 3 ? level * velBright(vel) : level;
        percEnv(g.gain, time, amount * vel, 0.002, decay);
        osc(ctx, "sine", freq * mult, time, stop)
          .connect(g)
          .connect(i === 0 ? st.center : side(st, i));
      });
    },
  },
];

const INSTRUMENT_BY_ID = new Map(INSTRUMENTS.map((i) => [i.id, i]));

export function getInstrument(id: string): Instrument {
  return INSTRUMENT_BY_ID.get(id) ?? INSTRUMENTS[0];
}

/**
 * ベースを軽く歪ませるカーブ。コンテキストごとに1本だけ作って使い回す。
 *
 * 素直な tanh 型。強く入れたときだけ頭が丸まる程度にしてある。
 */
const bassCurveCache = new WeakMap<BaseAudioContext, Float32Array<ArrayBuffer>>();

function bassDriveCurve(ctx: BaseAudioContext): Float32Array<ArrayBuffer> {
  const cached = bassCurveCache.get(ctx);
  if (cached) return cached;
  const n = 1024;
  const curve = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const x = (i / (n - 1)) * 2 - 1;
    curve[i] = Math.tanh(x * 1.7) / Math.tanh(1.7);
  }
  bassCurveCache.set(ctx, curve);
  return curve;
}

/** ベース音源（固定）。 */
export const bassInstrument: Instrument = {
  id: "bass",
  label: "ベース",
  tail: 0.8,
  play(ctx, dest, midi, time, dur, vel) {
    const freq = midiToFreq(midi);
    const stop = time + Math.max(dur, 0.1) + 0.8;
    const filter = ctx.createBiquadFilter();
    filter.type = "lowpass";
    filter.frequency.setValueAtTime(Math.min(2600, freq * 8), time);
    filter.frequency.exponentialRampToValueAtTime(Math.max(120, freq * 2.4), time + 0.25);
    filter.Q.value = 1.4;

    const g = ctx.createGain();
    adsrEnv(g.gain, time, Math.min(dur, 1.2), 0.5 * vel, 0.008, 0.18, 0.6, 0.14);

    // 軽く歪ませて倍音を足す。基音だけだとスマホのスピーカーで
    // 何も聞こえなくなるので、上の倍音で音程を感じさせる。
    const drive = ctx.createWaveShaper();
    drive.curve = bassDriveCurve(ctx);
    drive.oversample = "2x";
    filter.connect(g).connect(drive).connect(dest);

    osc(ctx, "sawtooth", freq, time, stop).connect(filter);
    const sub = ctx.createGain();
    sub.gain.value = 0.9;
    osc(ctx, "sine", freq, time, stop).connect(sub).connect(filter);
  },
};

/** ドラム1発をスケジュールする。 */
export function playDrum(
  ctx: BaseAudioContext,
  dest: AudioNode,
  voice: DrumVoice,
  time: number,
  vel: number,
): void {
  switch (voice) {
    case "kick": {
      const o = ctx.createOscillator();
      o.type = "sine";
      // 落ちきる手前を長めに取ると、床に響く感じが出る
      o.frequency.setValueAtTime(165, time);
      o.frequency.exponentialRampToValueAtTime(52, time + 0.09);
      o.frequency.exponentialRampToValueAtTime(41, time + 0.34);
      const g = ctx.createGain();
      percEnv(g.gain, time, 0.9 * vel, 0.002, 0.34);
      o.start(time);
      o.stop(time + 0.45);
      o.connect(g).connect(dest);

      // アタックのクリック
      const click = ctx.createOscillator();
      click.type = "triangle";
      click.frequency.value = 900;
      const cg = ctx.createGain();
      percEnv(cg.gain, time, 0.12 * vel, 0.001, 0.02);
      click.start(time);
      click.stop(time + 0.05);
      click.connect(cg).connect(dest);
      break;
    }
    case "snare": {
      const n = ctx.createBufferSource();
      n.buffer = noiseBuffer(ctx);
      const bp = ctx.createBiquadFilter();
      bp.type = "bandpass";
      bp.frequency.value = 1900;
      bp.Q.value = 0.7;
      const ng = ctx.createGain();
      percEnv(ng.gain, time, 0.44 * vel, 0.001, 0.16);
      n.start(time);
      n.stop(time + 0.3);
      n.connect(bp).connect(ng).connect(dest);

      // 上の抜け。ばらけた成分を左右に少し広げると、スネアが前に出る。
      const air = ctx.createBufferSource();
      air.buffer = noiseBuffer(ctx);
      const airHp = ctx.createBiquadFilter();
      airHp.type = "highpass";
      airHp.frequency.value = 4200;
      const airGain = ctx.createGain();
      percEnv(airGain.gain, time, 0.16 * vel, 0.001, 0.09);
      air.start(time);
      air.stop(time + 0.2);
      air.connect(airHp).connect(airGain).connect(panned(ctx, dest, 0.22));

      // 胴鳴り
      const body = ctx.createOscillator();
      body.type = "triangle";
      body.frequency.setValueAtTime(210, time);
      body.frequency.exponentialRampToValueAtTime(160, time + 0.1);
      const bg = ctx.createGain();
      percEnv(bg.gain, time, 0.22 * vel, 0.001, 0.1);
      body.start(time);
      body.stop(time + 0.2);
      body.connect(bg).connect(dest);
      break;
    }
    case "hat": {
      const n = ctx.createBufferSource();
      n.buffer = noiseBuffer(ctx);
      const hp = ctx.createBiquadFilter();
      hp.type = "highpass";
      hp.frequency.value = 8500;
      const g = ctx.createGain();
      percEnv(g.gain, time, 0.32 * vel, 0.001, 0.05);
      n.start(time);
      n.stop(time + 0.12);
      // ハイハットは少し右。実際のキットの並びに合わせると聴き分けやすい。
      n.connect(hp).connect(g).connect(panned(ctx, dest, 0.3));
      break;
    }
    case "ride": {
      const n = ctx.createBufferSource();
      n.buffer = noiseBuffer(ctx);
      const hp = ctx.createBiquadFilter();
      hp.type = "highpass";
      hp.frequency.value = 5200;
      const bp = ctx.createBiquadFilter();
      bp.type = "peaking";
      bp.frequency.value = 7200;
      bp.gain.value = 6;
      const g = ctx.createGain();
      percEnv(g.gain, time, 0.22 * vel, 0.002, 0.42);
      n.start(time);
      n.stop(time + 0.6);
      n.connect(hp).connect(bp).connect(g).connect(panned(ctx, dest, -0.25));
      break;
    }
  }
}

/** 一番長い余韻（書き出し尺の余白計算に使う）。 */
export function instrumentTail(instrumentId: string): number {
  return Math.max(getInstrument(instrumentId).tail, bassInstrument.tail);
}
