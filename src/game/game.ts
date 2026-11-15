import {
  cloneState,
  copyState,
  CRASHED,
  createState,
  FINISHED,
  RUNNING,
  tick,
  TICK_DT,
  type BikeConfig,
  type SimEvent,
  type SimState,
  type Track,
} from "../sim";
import { spawnRagdoll, stepRagdoll, type Ragdoll } from "./ragdoll";
import { makeReplay, trackHash, type Replay } from "./replay";

const CRASH_RESTART_DELAY = 2.0; // seconds
const REPLAY_END_DELAY = 2.5;

export interface RunResult {
  ticks: number;
  /** Best time before this run, if there was one. */
  previousBest: number | null;
  newBest: boolean;
}

/** Runs the sim at a fixed tick rate from real time; records inputs; plays ghosts and replays. */
export class Game {
  state: SimState;
  prev: SimState;
  /** Config the current run is simulated with (the live config, or a replay's own). */
  simCfg: BikeConfig;
  /** Input bitmask for every tick of the current run. */
  inputs: number[] = [];
  started = false;
  /** Input applied on the most recent tick (live or from a replay); for sound and effects. */
  lastInput = 0;
  events: SimEvent[] = [];
  ragdoll: Ragdoll | null = null;

  mode: "play" | "replay" = "play";
  private watching: Replay | null = null;

  /** Fastest finished run on this track, shown as a ghost. */
  best: Replay | null = null;
  /** Most recent finished run. */
  last: Replay | null = null;
  result: RunResult | null = null;
  ghost: SimState | null = null;
  ghostPrev: SimState | null = null;
  onNewBest: (r: Replay) => void = () => {};

  trackId: number;
  private acc = 0;
  private sinceEnd = 0;
  private configChanged = false;

  constructor(
    public track: Track,
    public cfg: BikeConfig,
  ) {
    this.trackId = trackHash(track);
    this.simCfg = cfg;
    this.state = createState(track, cfg);
    this.prev = cloneState(this.state);
    this.restart();
  }

  /** Switch to another track. Bests belong to a track, so they are dropped; the caller loads the new ones. */
  loadTrack(track: Track): void {
    this.track = track;
    this.trackId = trackHash(track);
    this.best = null;
    this.last = null;
    this.restart();
  }

  /** Start a fresh attempt. */
  restart(): void {
    this.mode = "play";
    this.watching = null;
    this.begin(this.cfg);
    if (this.best && this.best.trackId === this.trackId) {
      this.ghost = createState(this.track, this.best.cfg);
      this.ghostPrev = cloneState(this.ghost);
    }
  }

  /** Watch a recorded run. */
  watch(replay: Replay): void {
    this.mode = "replay";
    this.watching = replay;
    this.begin(replay.cfg);
    this.started = true;
  }

  /** Tuning the bike mid-run makes that run unrepeatable, so it will not be saved. */
  markConfigChanged(): void {
    this.configChanged = true;
  }

  private begin(cfg: BikeConfig): void {
    this.simCfg = cfg;
    this.state = createState(this.track, cfg);
    this.prev = cloneState(this.state);
    this.inputs = [];
    this.started = false;
    this.lastInput = 0;
    this.ragdoll = null;
    this.ghost = null;
    this.ghostPrev = null;
    this.result = null;
    this.acc = 0;
    this.sinceEnd = 0;
    this.configChanged = false;
  }

  /** Advance by real elapsed seconds. Returns the interpolation factor between prev and state. */
  update(dt: number, input: number): number {
    // The clock starts on the first key press.
    if (!this.started && input !== 0) this.started = true;
    if (!this.started) return 1;

    this.acc += Math.min(dt, 0.1);
    while (this.acc >= TICK_DT) {
      this.step(input);
      this.acc -= TICK_DT;
    }

    const s = this.state;
    if (s.status !== RUNNING) {
      this.sinceEnd += dt;
      if (this.mode === "replay") {
        if (this.sinceEnd > REPLAY_END_DELAY) this.restart();
      } else if (s.status === CRASHED && this.sinceEnd > CRASH_RESTART_DELAY) {
        this.restart();
      }
    }
    return this.acc / TICK_DT;
  }

  private step(liveInput: number): void {
    const s = this.state;
    const wasRunning = s.status === RUNNING;
    const input = this.watching ? (this.watching.inputs[s.tick] ?? 0) : liveInput;

    this.lastInput = wasRunning ? input : 0;
    copyState(this.prev, s);
    if (wasRunning && this.mode === "play") this.inputs.push(input);
    tick(s, input, this.track, this.simCfg, this.events);

    if (this.ghost && this.ghostPrev && this.best) {
      copyState(this.ghostPrev, this.ghost);
      tick(this.ghost, this.best.inputs[this.ghost.tick] ?? 0, this.track, this.best.cfg);
    }

    if (wasRunning && s.status === CRASHED) this.ragdoll = spawnRagdoll(s, this.simCfg);
    if (this.ragdoll) stepRagdoll(this.ragdoll, this.track, this.simCfg.gravity);

    if (wasRunning && s.status === FINISHED && this.mode === "play") this.onFinish();
  }

  private onFinish(): void {
    const ticks = this.state.endTick;
    const previousBest = this.best ? this.best.ticks : null;
    if (this.configChanged) {
      this.result = { ticks, previousBest, newBest: false };
      return;
    }
    const replay = makeReplay(this.track, this.simCfg, this.inputs, this.state);
    this.last = replay;
    const newBest = previousBest === null || ticks < previousBest;
    if (newBest) {
      this.best = replay;
      this.onNewBest(replay);
    }
    this.result = { ticks, previousBest, newBest };
  }
}
