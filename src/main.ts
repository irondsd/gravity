import { GameAudio } from "./audio/audio";
import { Game } from "./game/game";
import { Keyboard } from "./game/input";
import { decodeReplay, encodeReplay, trackHash, verifyReplay, type Replay } from "./game/replay";
import { generateTrack, type LevelParams } from "./level/generator";
import { LevelBuilder, type Level } from "./level/level";
import { buildTestTrack } from "./level/testTrack";
import { Effects } from "./render/effects";
import { Renderer } from "./render/renderer";
import { defaultConfig, PHYSICS_VERSION } from "./sim";
import { createTuningPanel, loadConfig, loadLevel, saveLevel } from "./ui/tuning";

const canvas = document.getElementById("game") as HTMLCanvasElement;
const cfg = loadConfig();
const level = loadLevel();

// A short flat placeholder until the first real level is ready.
const game = new Game(generateTrack({ seed: 0, difficulty: 0, length: 150 }), cfg);
const effects = new Effects();
const audio = new GameAudio();
const renderer = new Renderer(canvas, effects);
const keyboard = new Keyboard(window);

// ---- best runs: one per track, kept in the browser, used only if they still verify ----
const bestKey = () => `gravity.best.${game.trackId}`;
function loadBest(): void {
  try {
    const saved = decodeReplay(localStorage.getItem(bestKey()) ?? "");
    if (saved && verifyReplay(game.track, saved)) game.best = saved;
  } catch {
    // storage unavailable; play without a saved best
  }
  game.restart();
}
game.onNewBest = (r) => {
  try {
    localStorage.setItem(bestKey(), encodeReplay(r));
  } catch {
    // storage unavailable; the best run lasts for this session only
  }
};

// ---- levels: built and verified in slices so the page never freezes; results are cached ----
let building: LevelBuilder | null = null;
let buildingParams: LevelParams | null = null;
let solution: Replay | null = null;

interface CachedLevel {
  attempt: number;
  verified: boolean;
  failures: number;
  ticks: number;
  trackId: number;
  solution: string | null;
}
// Bump PHYSICS_VERSION whenever the sim changes: cached solver runs recorded under old physics no longer play out.
const levelKey = (p: LevelParams) => `gravity.level.v${PHYSICS_VERSION}.${p.seed}.${p.difficulty}.${p.length}`;

function useLevel(l: Level, label: string): void {
  game.loadTrack(l.track);
  loadBest();
  solution = l.solution
    ? { trackId: game.trackId, cfg: { ...defaultConfig }, inputs: l.solution, ticks: l.solutionTicks, hash: 0 }
    : null;
  renderer.hasSolution = solution !== null;
  renderer.levelLabel = label;
  renderer.busyText = "";
  renderer.resetCamera();
  effects.clear();
}

function describe(l: Level): string {
  const base = `seed ${level.seed} · difficulty ${level.difficulty}`;
  if (!l.verified) return `${base} · not verified passable`;
  return `${base} · verified passable (solver crashed ${l.failures}×)`;
}

function applyLevel(): void {
  building = null;
  if (level.track === "test") {
    useLevel({ track: buildTestTrack(), attempt: 0, verified: false, solution: null, solutionTicks: 0, failures: 0 }, "test track");
    return;
  }
  const params: LevelParams = { seed: level.seed, difficulty: level.difficulty / 100, length: level.length };
  // Cached verdict from an earlier visit; trusted only if the generator still makes the same track.
  try {
    const c = JSON.parse(localStorage.getItem(levelKey(params)) ?? "null") as CachedLevel | null;
    if (c) {
      const track = generateTrack({ ...params, attempt: c.attempt });
      if (trackHash(track) === c.trackId) {
        const sol = c.solution ? decodeReplay(c.solution) : null;
        const cached: Level = { track, attempt: c.attempt, verified: c.verified, solution: sol ? sol.inputs : null, solutionTicks: c.ticks, failures: c.failures };
        useLevel(cached, describe(cached));
        return;
      }
    }
  } catch {
    // unreadable cache; just build it again
  }
  building = new LevelBuilder(params);
  buildingParams = params;
  renderer.busyText = "checking that it can be finished…";
}

function buildSlice(): void {
  if (!building || !buildingParams) return;
  const t0 = performance.now();
  let done: Level | null = null;
  while (!done && performance.now() - t0 < 12) done = building.run(2000);
  if (!done) {
    renderer.busyText = `checking that it can be finished…  attempt ${building.attempt + 1}, ${Math.round(building.progress * 100)}% of the way`;
    return;
  }
  const params = buildingParams;
  building = null;
  useLevel(done, describe(done));
  try {
    const sol = solution ? encodeReplay(solution) : null;
    const c: CachedLevel = { attempt: done.attempt, verified: done.verified, failures: done.failures, ticks: done.solutionTicks, trackId: game.trackId, solution: sol };
    localStorage.setItem(levelKey(params), JSON.stringify(c));
  } catch {
    // storage unavailable or full; the level is simply rebuilt next time
  }
}

const gui = createTuningPanel(cfg, level, applyLevel, (geometry) => {
  if (geometry) game.restart();
  else game.markConfigChanged();
});
saveLevel(level);
applyLevel();
// opening a shared level link in the same tab
window.addEventListener("hashchange", () => {
  Object.assign(level, loadLevel());
  gui.controllersRecursive().forEach((c) => c.updateDisplay());
  applyLevel();
});

keyboard.onRestart = () => game.restart();
// Browsers only allow sound after a key press or click.
window.addEventListener("keydown", () => audio.unlock());
window.addEventListener("pointerdown", () => audio.unlock());
keyboard.onKey = (code) => {
  if (code === "KeyM") {
    audio.toggleMute();
    renderer.soundOn = !audio.muted;
  } else if (code === "KeyN") {
    level.track = "generated";
    // next level = one notch harder; at the top, a fresh seed at full difficulty
    if (level.difficulty < 100) level.difficulty++;
    else level.seed = (level.seed + 1) % 1000000;
    saveLevel(level);
    gui.controllersRecursive().forEach((c) => c.updateDisplay());
    applyLevel();
  } else if (building) {
    return;
  } else if (code === "KeyP" && game.best) game.watch(game.best);
  else if (code === "KeyL" && game.last) game.watch(game.last);
  else if (code === "KeyH" && solution) game.watch(solution);
};

let last = performance.now();
let lastTick = 0;
function frame(now: number): void {
  const dt = (now - last) / 1000;
  last = now;
  buildSlice();
  // the game is paused while a level is being built
  const alpha = building ? 1 : game.update(dt, keyboard.mask);
  // any restart rewinds the tick counter; snap the camera back to the start
  if (game.state.tick < lastTick) {
    renderer.resetCamera();
    effects.clear();
    audio.reset();
  }
  lastTick = game.state.tick;
  for (const e of game.events) {
    audio.onEvent(e);
    effects.onEvent(e, game);
  }
  game.events.length = 0;
  audio.update(game, dt);
  effects.update(game, dt);
  renderer.draw(game, alpha, dt);
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);

// Handy for poking at the game from the browser console.
Object.assign(window, { game, cfg, audio, GameAudio, replay: { decodeReplay, encodeReplay, verifyReplay } });
