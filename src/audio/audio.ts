// All sound is synthesized with the Web Audio API; there are no audio files.
// Nothing here feeds back into the simulation.
import { CAUSE_NECK, CRASHED, IN_THROTTLE, RUNNING, type SimEvent } from "../sim";
import type { Game } from "../game/game";

// Virtual gearbox, used only to make the engine note rise and fall like a real bike.
const GEAR_TOP_SPEED = [8, 13, 19, 26, 34]; // m/s at full revs in each gear
const IDLE = 0.12;

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

export class GameAudio {
  ctx: BaseAudioContext | null = null;
  muted = false;
  private background = false;
  /** 0..1 overall loudness. */
  volume = 1;
  /** Pain screams and bone cracks. */
  screams = true;

  private master!: GainNode;
  private noise!: AudioBuffer;
  // engine
  private osc: OscillatorNode[] = [];
  private lfo!: OscillatorNode;
  private engFilter!: BiquadFilterNode;
  private engGain!: GainNode;
  private engNoiseFilter!: BiquadFilterNode;
  private engNoiseGain!: GainNode;
  // continuous layers
  private skidGain!: GainNode;
  private windGain!: GainNode;
  private windFilter!: BiquadFilterNode;

  private rpm = IDLE;
  private gear = 0;
  private load = 0;
  private alive = 1; // engine fades out after a crash
  private lastLand = [0, 0];

  /** Create the audio context. Browsers only allow this after a key press or click. */
  unlock(): void {
    if (this.ctx) {
      if (this.ctx instanceof AudioContext && this.ctx.state === "suspended" && !this.background) void this.ctx.resume();
      return;
    }
    const Ctor = window.AudioContext;
    if (!Ctor) return;
    this.attach(new Ctor());
  }

  /** Stop all sound output while the tab is in the background, and pick it up again afterwards. */
  setBackground(hidden: boolean): void {
    this.background = hidden;
    if (!(this.ctx instanceof AudioContext)) return;
    if (hidden) void this.ctx.suspend();
    else void this.ctx.resume();
  }

  toggleMute(): void {
    this.setLevel(!this.muted, this.volume);
  }

  /** Mute or unmute, and set the overall loudness (0..1). */
  setLevel(muted: boolean, volume: number): void {
    this.muted = muted;
    this.volume = volume;
    if (this.ctx) this.master.gain.setTargetAtTime(this.level(), this.ctx.currentTime, 0.02);
  }

  private level(): number {
    return this.muted ? 0 : 0.55 * this.volume;
  }

  /** A short rising chime, for an earned achievement. */
  chime(): void {
    const ctx = this.ctx;
    if (!ctx) return;
    const t = ctx.currentTime;
    const notes = [783.99, 1046.5, 1318.5];
    for (let i = 0; i < notes.length; i++) this.tone(t + i * 0.07, 0.35, "sine", notes[i]!, notes[i]!, 0.16);
  }

  /** Build the sound graph on a context (a live one, or an offline one for testing). */
  attach(ctx: BaseAudioContext): void {
    this.ctx = ctx;
    const comp = ctx.createDynamicsCompressor();
    comp.threshold.value = -14;
    comp.ratio.value = 6;
    comp.connect(ctx.destination);
    this.master = ctx.createGain();
    this.master.gain.value = this.level();
    this.master.connect(comp);

    this.noise = ctx.createBuffer(1, ctx.sampleRate * 2, ctx.sampleRate);
    const data = this.noise.getChannelData(0);
    for (let i = 0; i < data.length; i++) data[i] = Math.random() * 2 - 1;
    const noiseSrc = ctx.createBufferSource();
    noiseSrc.buffer = this.noise;
    noiseSrc.loop = true;
    noiseSrc.start();

    // Engine: three oscillators -> distortion -> low-pass, pulsed at half the firing rate
    // for a single-cylinder thump, plus a little filtered noise for intake and exhaust hiss.
    const mix = ctx.createGain();
    const types: OscillatorType[] = ["sawtooth", "square", "sawtooth"];
    const gains = [0.5, 0.35, 0.12];
    for (let i = 0; i < 3; i++) {
      const o = ctx.createOscillator();
      o.type = types[i]!;
      const g = ctx.createGain();
      g.gain.value = gains[i]!;
      o.connect(g).connect(mix);
      o.start();
      this.osc.push(o);
    }
    const shaper = ctx.createWaveShaper();
    const curve = new Float32Array(1024);
    for (let i = 0; i < curve.length; i++) curve[i] = Math.tanh(((i / (curve.length - 1)) * 2 - 1) * 2.5);
    shaper.curve = curve;
    this.engFilter = ctx.createBiquadFilter();
    this.engFilter.type = "lowpass";
    this.engFilter.Q.value = 1.2;
    const pulse = ctx.createGain();
    pulse.gain.value = 0.7;
    this.lfo = ctx.createOscillator();
    const lfoDepth = ctx.createGain();
    lfoDepth.gain.value = 0.3;
    this.lfo.connect(lfoDepth).connect(pulse.gain);
    this.lfo.start();
    this.engGain = ctx.createGain();
    this.engGain.gain.value = 0;
    mix.connect(shaper).connect(this.engFilter).connect(pulse).connect(this.engGain).connect(this.master);

    this.engNoiseFilter = ctx.createBiquadFilter();
    this.engNoiseFilter.type = "bandpass";
    this.engNoiseFilter.Q.value = 0.8;
    this.engNoiseGain = ctx.createGain();
    this.engNoiseGain.gain.value = 0;
    noiseSrc.connect(this.engNoiseFilter).connect(this.engNoiseGain).connect(this.master);

    // Tire skid: band-passed noise.
    const skidFilter = ctx.createBiquadFilter();
    skidFilter.type = "bandpass";
    skidFilter.frequency.value = 1700;
    skidFilter.Q.value = 2.5;
    this.skidGain = ctx.createGain();
    this.skidGain.gain.value = 0;
    noiseSrc.connect(skidFilter).connect(this.skidGain).connect(this.master);

    // Wind: low-passed noise that grows with speed.
    this.windFilter = ctx.createBiquadFilter();
    this.windFilter.type = "lowpass";
    this.windGain = ctx.createGain();
    this.windGain.gain.value = 0;
    noiseSrc.connect(this.windFilter).connect(this.windGain).connect(this.master);

    this.setEngine(IDLE, 0, 1);
  }

  /** Set the engine note. rpm and load are 0..1; level scales volume (0 = stalled). */
  setEngine(rpm: number, load: number, level: number): void {
    const ctx = this.ctx;
    if (!ctx) return;
    const t = ctx.currentTime;
    const f = 26 + rpm * 190;
    this.osc[0]!.frequency.setTargetAtTime(f, t, 0.02);
    this.osc[1]!.frequency.setTargetAtTime(f * 0.5, t, 0.02);
    this.osc[2]!.frequency.setTargetAtTime(f * 2.02, t, 0.02);
    this.lfo.frequency.setTargetAtTime(f * 0.5, t, 0.02);
    this.engFilter.frequency.setTargetAtTime(260 + rpm * 1300 + load * 1500, t, 0.03);
    this.engGain.gain.setTargetAtTime((0.1 + 0.13 * load + 0.06 * rpm) * level, t, 0.03);
    this.engNoiseFilter.frequency.setTargetAtTime(900 + rpm * 2200, t, 0.03);
    this.engNoiseGain.gain.setTargetAtTime((0.012 + 0.04 * load * rpm) * level, t, 0.03);
  }

  /** Fade out the engine, skid and wind (menus, pause). */
  quiet(): void {
    const ctx = this.ctx;
    if (!ctx) return;
    this.setEngine(IDLE, 0, 0);
    this.skidGain.gain.setTargetAtTime(0, ctx.currentTime, 0.04);
    this.windGain.gain.setTargetAtTime(0, ctx.currentTime, 0.04);
  }

  reset(): void {
    this.rpm = IDLE;
    this.gear = 0;
    this.load = 0;
    this.alive = 1;
  }

  /** Per-frame update of the continuous sounds from the current game state. */
  update(game: Game, dt: number): void {
    const ctx = this.ctx;
    if (!ctx) return;
    const s = game.state;
    const cfg = game.simCfg;
    const running = s.status === RUNNING && game.started;
    const throttle = running && (game.lastInput & IN_THROTTLE) !== 0;

    // Engine revs follow rear wheel speed through the gearbox.
    const wheelSpeed = Math.max(0, -s.rear.w) * cfg.wheelRadius;
    let norm = wheelSpeed / GEAR_TOP_SPEED[this.gear]!;
    if (norm > 0.93 && this.gear < GEAR_TOP_SPEED.length - 1) this.gear++;
    else if (norm < 0.45 && this.gear > 0) this.gear--;
    norm = wheelSpeed / GEAR_TOP_SPEED[this.gear]!;
    let target = Math.max(IDLE, Math.min(1.05, norm));
    if (throttle && target < 0.4) target = 0.4; // clutch slip when pulling away
    if (s.status === CRASHED) {
      target = 0;
      this.alive = Math.max(0, this.alive - dt / 0.6);
    }
    this.rpm += (target - this.rpm) * Math.min(1, dt * (target > this.rpm ? 9 : 5));
    this.load += ((throttle ? 1 : 0) - this.load) * Math.min(1, dt * 14);
    this.setEngine(this.rpm, this.load, this.alive);

    const t = ctx.currentTime;
    // Skid: how fast each grounded tire slides along the bike's direction.
    let slip = 0;
    for (const wh of [s.rear, s.front]) {
      if (wh.grounded === 0) continue;
      const along = wh.vx * s.rx + wh.vy * s.ry + wh.w * cfg.wheelRadius;
      slip = Math.max(slip, Math.abs(along));
    }
    this.skidGain.gain.setTargetAtTime(clamp((slip - 2.5) / 12, 0, 1) * 0.22, t, 0.04);

    const speed = Math.hypot(s.vx, s.vy);
    const w = Math.min(1, speed / 35);
    this.windGain.gain.setTargetAtTime(w * w * 0.22, t, 0.1);
    this.windFilter.frequency.setTargetAtTime(280 + speed * 26, t, 0.1);
  }

  onEvent(e: SimEvent): void {
    const ctx = this.ctx;
    if (!ctx) return;
    const t = ctx.currentTime;
    if (e.type === "land") {
      if (t - this.lastLand[e.wheel]! < 0.08) return;
      this.lastLand[e.wheel] = t;
      const k = clamp(e.speed / 9, 0.1, 1);
      this.tone(t, 0.16, "sine", 115, 42, 0.5 * k); // suspension thump
      this.burst(t, 0.07 + 0.05 * k, "bandpass", 2100, 3, 0.16 * k); // tire chirp
    } else if (e.type === "headScrape") {
      this.burst(t, 0.12, "bandpass", 3200, 1.2, 0.2); // helmet on the ground
      if (e.speed > 0.6 && this.screams) this.voice(t + 0.02, 0.22, 420, 300, 0.35); // yelp
    } else if (e.type === "fenderBreak") {
      // plastic snap
      this.burst(t, 0.03, "highpass", 2400, 0.7, 0.55);
      this.burst(t + 0.012, 0.09, "bandpass", 900, 1.5, 0.35);
    } else if (e.type === "crash") {
      this.tone(t, 0.22, "sine", 90, 35, 0.8); // body thud
      if (this.screams) {
        this.crack(t);
        if (e.cause === CAUSE_NECK) this.voice(t + 0.05, 0.75, 520, 260, 0.5);
        else this.voice(t + 0.03, 0.32, 330, 150, 0.5);
      }
    } else if (e.type === "finish") {
      const notes = [523.25, 659.25, 783.99, 1046.5];
      for (let i = 0; i < notes.length; i++) this.tone(t + i * 0.09, 0.5, "triangle", notes[i]!, notes[i]!, 0.18);
    }
  }

  /** Bone break: a few sharp clicks over a dull crunch. */
  crack(t: number): void {
    let at = t;
    for (let i = 0; i < 3; i++) {
      this.burst(at, 0.014, "highpass", 1800 + Math.random() * 900, 0.7, 0.75);
      at += 0.025 + Math.random() * 0.04;
    }
    this.burst(t, 0.05, "lowpass", 420, 0.7, 0.6);
  }

  /** Short filtered-noise sound. */
  private burst(t: number, dur: number, type: BiquadFilterType, freq: number, q: number, gain: number): void {
    const ctx = this.ctx!;
    const src = ctx.createBufferSource();
    src.buffer = this.noise;
    const f = ctx.createBiquadFilter();
    f.type = type;
    f.frequency.value = freq;
    f.Q.value = q;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(gain, t + 0.002);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    src.connect(f).connect(g).connect(this.master);
    src.start(t, Math.random() * 1.5);
    src.stop(t + dur + 0.02);
  }

  /** Pitched blip that slides from f0 to f1. */
  private tone(t: number, dur: number, type: OscillatorType, f0: number, f1: number, gain: number): void {
    const ctx = this.ctx!;
    const o = ctx.createOscillator();
    o.type = type;
    o.frequency.setValueAtTime(f0, t);
    o.frequency.exponentialRampToValueAtTime(f1, t + dur);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(gain, t + 0.004);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    o.connect(g).connect(this.master);
    o.start(t);
    o.stop(t + dur + 0.02);
  }

  /** Crude human voice: a rough sawtooth through "AH" vowel formants. Used for yelps and screams. */
  voice(t: number, dur: number, peak: number, end: number, gain: number): void {
    const ctx = this.ctx!;
    const pitch = 0.88 + Math.random() * 0.26;
    const out = ctx.createGain();
    out.gain.setValueAtTime(0, t);
    out.gain.linearRampToValueAtTime(gain, t + 0.025);
    out.gain.setValueAtTime(gain, t + dur * 0.6);
    out.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    out.connect(this.master);

    const formants: [number, number, number][] = [
      [850, 6, 1],
      [1250, 8, 0.7],
      [2900, 10, 0.35],
    ];
    const sum = ctx.createGain();
    for (const [freq, q, g] of formants) {
      const f = ctx.createBiquadFilter();
      f.type = "bandpass";
      f.frequency.value = freq;
      f.Q.value = q;
      const fg = ctx.createGain();
      fg.gain.value = g * 3;
      sum.connect(f).connect(fg).connect(out);
    }

    // wobble makes it sound strained instead of like a steady note
    const vib = ctx.createOscillator();
    vib.frequency.value = 9 + Math.random() * 4;
    const vibDepth = ctx.createGain();
    vibDepth.gain.setValueAtTime(4, t);
    vibDepth.gain.linearRampToValueAtTime(28, t + dur);
    vib.connect(vibDepth);
    vib.start(t);
    vib.stop(t + dur + 0.05);

    for (const detune of [1, 1.013]) {
      const o = ctx.createOscillator();
      o.type = "sawtooth";
      o.frequency.setValueAtTime(peak * 0.7 * pitch * detune, t);
      o.frequency.linearRampToValueAtTime(peak * pitch * detune, t + Math.min(0.08, dur * 0.3));
      o.frequency.exponentialRampToValueAtTime(end * pitch * detune, t + dur);
      vibDepth.connect(o.frequency);
      o.connect(sum);
      o.start(t);
      o.stop(t + dur + 0.05);
    }
    // breath
    const src = ctx.createBufferSource();
    src.buffer = this.noise;
    const ng = ctx.createGain();
    ng.gain.value = 0.25;
    src.connect(ng).connect(sum);
    src.start(t, Math.random());
    src.stop(t + dur + 0.05);
  }
}
