import riderFile from "../data/rider.json";
import { runEpisode } from "./ai/episode";
import { loadRider, type RiderFile } from "./ai/policy";
import { achievementById, finishAchievements, RunTracker, type Achievement } from "./app/achievements";
import { customLevel, ladderById, ladderLevel, type LevelSpec } from "./app/modes";
import { planetConfig } from "./app/planets";
import { RaceBuilder, racePlace, type RaceLevel } from "./app/race";
import { hashText, loadSave, newSave, storeSave } from "./app/save";
import { GameAudio } from "./audio/audio";
import { Game } from "./game/game";
import { Keyboard } from "./game/input";
import { decodeReplay, encodeReplay, trackHash, verifyReplay, type Replay } from "./game/replay";
import { generateTrack } from "./level/generator";
import { LevelBuilder, type Level } from "./level/level";
import { Effects } from "./render/effects";
import { Renderer } from "./render/renderer";
import { themeById } from "./render/themes";
import { CRASHED, defaultConfig, FINISHED, PHYSICS_VERSION, RUNNING, type BikeConfig } from "./sim";
import { Menu, type MenuHost } from "./ui/menu";

/** `bun run dev` serves the page with this set: tuning panel on, every level unlocked. */
const DEV = document.documentElement.dataset.dev !== undefined;

const canvas = document.getElementById("game") as HTMLCanvasElement;
let save = loadSave();
storeSave(save); // keeps a freshly generated name

/** The standard bike. In dev mode it is the live-tuned one. */
let baseCfg: BikeConfig = defaultConfig;

const game = new Game(generateTrack({ seed: 0, difficulty: 0, length: 150 }), baseCfg);
const effects = new Effects();
const audio = new GameAudio();
const renderer = new Renderer(canvas, effects);
const keyboard = new Keyboard(window);
const tracker = new RunTracker();

// The trained AI rider (data/rider.json, made by `bun src/ai/train.ts`). It rides the standard bike.
const rider = loadRider(riderFile as RiderFile);

type Screen = "menu" | "loading" | "playing" | "paused" | "result";
let screen: Screen = "menu";
let spec: LevelSpec | null = null;
let level: Level | null = null;
let builder: LevelBuilder | RaceBuilder | null = null;
let solution: Replay | null = null;
/** Counts down to the result screen after crossing the line, so the finish can be seen first. */
let resultIn = -1;
let pendingResult: (() => void) | null = null;
/** Achievements earned during the current run, to list on the result screen. */
let earnedThisRun: Achievement[] = [];

function applyOptions(): void {
  const o = save.options;
  audio.setLevel(!o.sound, o.volume);
  audio.screams = o.screams;
  if (effects.gore && !o.blood) effects.clearBlood();
  effects.gore = o.blood;
  renderer.shakeScale = o.shake ? 1 : 0;
  game.autoRestart = o.autoRestart;
  game.showGhost = o.ghost;
}

function award(id: string): void {
  if (save.achievements[id] !== undefined) return;
  const a = achievementById(id);
  if (!a) return;
  save.achievements[id] = Date.now();
  storeSave(save);
  earnedThisRun.push(a);
  menu.toast(a);
  audio.chime();
}

/** The bike a level is ridden with. In dev mode the standard levels use the tuning panel's values live. */
function bikeFor(s: LevelSpec): BikeConfig {
  if (!DEV) return s.cfg;
  return s.planet.g === 1 ? baseCfg : planetConfig(s.planet.g, baseCfg);
}

// ---- best runs: one per level, kept in the browser, used only if they still play back exactly ----
const bestKey = (s: LevelSpec) => `gravity.best.v${PHYSICS_VERSION}.${s.id}`;
function loadBest(s: LevelSpec): void {
  try {
    const saved = decodeReplay(localStorage.getItem(bestKey(s)) ?? "");
    // the bike comes from the level, not from storage
    if (saved) {
      const replay = { ...saved, cfg: bikeFor(s) };
      if (verifyReplay(game.track, replay)) game.best = replay;
    }
  } catch {
    // storage unavailable; play without a saved best
  }
}
game.onNewBest = (r) => {
  if (!spec) return;
  try {
    localStorage.setItem(bestKey(spec), encodeReplay(r));
  } catch {
    // storage unavailable; the best run lasts for this session only
  }
};

// ---- levels: built and checked in slices so the page never freezes; verdicts are cached ----
interface CachedLevel {
  attempt: number;
  verified: boolean;
  failures: number;
  ticks: number;
  trackId: number;
  solution: string | null;
}
const levelKey = (s: LevelSpec) => `gravity.level.v${PHYSICS_VERSION}.${s.id}`;

function setScreen(next: Screen): void {
  screen = next;
  keyboard.enabled = next === "playing";
  keyboard.mask = 0;
  renderer.hudHidden = next === "menu";
  renderer.focusX = next === "menu" ? 0.86 : 0.5;
  if (next !== "playing") audio.quiet();
}

function startLevel(s: LevelSpec): void {
  spec = s;
  level = null;
  solution = null;
  resultIn = -1;
  menu.hide();
  setScreen("loading");
  save.lastLadder = s.ladder;
  storeSave(save);
  setWorld(s.planet.theme);
  renderer.levelLabel = s.title;
  renderer.hudLines = [];
  renderer.busyText = "getting ready…";
  // show an empty stretch of the right world while the level is checked
  game.cfg = bikeFor(s);
  game.loadTrack(generateTrack({ seed: 0, difficulty: 0, length: 150 }));
  renderer.resetCamera();
  effects.clear();

  const cfg = bikeFor(s);
  if (s.race) {
    builder = rider ? new RaceBuilder(s.params, cfg, rider, s.race) : new LevelBuilder(s.params, cfg);
    return;
  }
  // Cached verdict from an earlier visit; trusted only if the generator still makes the same track.
  if (!DEV) {
    try {
      const c = JSON.parse(localStorage.getItem(levelKey(s)) ?? "null") as CachedLevel | null;
      if (c) {
        const track = generateTrack({ ...s.params, attempt: c.attempt });
        if (trackHash(track) === c.trackId) {
          const sol = c.solution ? decodeReplay(c.solution) : null;
          useLevel({ track, attempt: c.attempt, verified: c.verified, solution: sol ? sol.inputs : null, solutionTicks: c.ticks, failures: c.failures });
          return;
        }
      }
    } catch {
      // unreadable cache; just build it again
    }
  }
  // the level may already be half-checked from while the one before it was being ridden
  builder = ahead && ahead.spec.id === s.id ? ahead.builder : new LevelBuilder(s.params, cfg);
  ahead = null;
}

function cacheLevel(s: LevelSpec, done: Level): void {
  try {
    const cfg = bikeFor(s);
    const sol = done.solution ? encodeReplay({ trackId: trackHash(done.track), cfg, inputs: done.solution, ticks: done.solutionTicks, hash: 0 }) : null;
    const c: CachedLevel = { attempt: done.attempt, verified: done.verified, failures: done.failures, ticks: done.solutionTicks, trackId: trackHash(done.track), solution: sol };
    localStorage.setItem(levelKey(s), JSON.stringify(c));
  } catch {
    // storage unavailable or full; the level is simply rebuilt next time
  }
}

/** The next level of the ladder, checked a little each frame while this one is ridden, so it is ready when wanted. */
let ahead: { spec: LevelSpec; builder: LevelBuilder } | null = null;

function planAhead(s: LevelSpec): void {
  ahead = null;
  const ladder = ladderById(s.ladder);
  if (DEV || !ladder || ladder.race || s.index >= ladder.count) return;
  const next = ladderLevel(save.name, ladder, s.index + 1);
  try {
    if (localStorage.getItem(levelKey(next))) return;
  } catch {
    return;
  }
  ahead = { spec: next, builder: new LevelBuilder(next.params, next.cfg) };
}

function buildAhead(): void {
  if (!ahead || builder) return;
  const t0 = performance.now();
  let done: Level | null = null;
  while (!done && performance.now() - t0 < 3) done = ahead.builder.run(500);
  if (!done) return;
  cacheLevel(ahead.spec, done);
  ahead = null;
}

function setWorld(themeId: string): void {
  const theme = themeById(themeId);
  renderer.theme = theme;
  effects.dustColor = theme.dust;
  effects.dirtColor = theme.dirt;
}

function buildSlice(): void {
  if (!builder || !spec) return;
  const t0 = performance.now();
  let done: Level | null = null;
  while (!done && performance.now() - t0 < 12) done = builder instanceof RaceBuilder ? builder.run() : builder.run(2000);
  if (!done) {
    renderer.busyText =
      builder instanceof RaceBuilder
        ? `finding a track the AI can finish…  try ${builder.attempt + 1}      Esc to cancel`
        : `checking that it can be finished…  attempt ${builder.attempt + 1}, ${Math.round(builder.progress * 100)}% of the way      Esc to cancel`;
    return;
  }
  const wasRace = builder instanceof RaceBuilder;
  builder = null;
  if (!wasRace && !DEV) cacheLevel(spec, done);
  useLevel(done);
}

function useLevel(l: Level): void {
  if (!spec) return;
  level = l;
  const cfg = bikeFor(spec);
  game.cfg = cfg;
  game.loadTrack(l.track);
  loadBest(spec);
  const runs = (l as RaceLevel).runs;
  game.rivals = runs ? runs.map((r) => ({ trackId: game.trackId, cfg, inputs: r.inputs, ticks: r.ticks, hash: 0 })) : [];
  solution = l.solution ? { trackId: game.trackId, cfg, inputs: l.solution, ticks: l.solutionTicks, hash: 0 } : null;
  renderer.busyText = "";
  renderer.levelLabel = l.verified ? spec.title : `${spec.title} · could not be proven passable`;
  renderer.startHint = spec.race
    ? `Beat ${runs?.length === 1 ? "the AI rider" : `all ${runs?.length ?? 0} AI riders`}. They start when you do.`
    : "↑ throttle   ↓ brake   ← lean back   → lean forward";
  renderer.crashHint = save.options.autoRestart ? "" : "R to try again";
  renderer.keysLabel = "R restart     Esc pause     M sound";
  effects.clear();
  planAhead(spec);
  beginRun();
  setScreen("playing");
}

/** Fresh attempt at the current level. */
function beginRun(): void {
  resultIn = -1;
  pendingResult = null;
  earnedThisRun = [];
  tracker.reset();
  game.restart();
  renderer.hudLines = [];
  menu.hide();
  setScreen("playing");
}

// ---- what happens during and after a run ----
game.onTick = (s) => {
  for (const id of tracker.tick(s, spec?.planet.g === 1)) award(id);
};

function onCrash(): void {
  if (!spec) return;
  save.stats.crashes++;
  save.stats.streak = 0;
  save.fails[spec.id] = (save.fails[spec.id] ?? 0) + 1;
  if (save.stats.crashes >= 100) award("dummy");
  storeSave(save);
}

function onFinish(): void {
  if (!spec || !level) return;
  const s = spec;
  const ticks = game.state.endTick;
  const previousBest = save.records[s.id] ?? null;
  const newRecord = previousBest === null || ticks < previousBest;
  if (newRecord) save.records[s.id] = ticks;
  const failsBefore = save.fails[s.id] ?? 0;
  delete save.fails[s.id];

  const runs = (level as RaceLevel).runs;
  const place = s.race && runs ? racePlace(ticks, runs) : null;
  const fastest = runs?.find((r) => r.finished);
  const won = place === null || place === 1;

  const before = save.progress[s.ladder] ?? 0;
  if (s.ladder !== "custom" && won) save.progress[s.ladder] = Math.max(before, s.index);
  save.stats.finishes++;
  save.stats.streak++;
  if (!save.stats.planets.includes(s.planet.id)) save.stats.planets.push(s.planet.id);
  storeSave(save);

  for (const id of finishAchievements({
    ladder: s.ladder,
    index: s.index,
    difficulty: s.params.difficulty,
    length: s.params.length,
    ticks,
    failsBefore,
    previousBest,
    place,
    marginTicks: fastest ? fastest.ticks - ticks : null,
    headScraped: tracker.headScraped,
    fenderBroken: game.state.fenderBroken === 1,
    standardDone: save.progress.standard ?? 0,
    streak: save.stats.streak,
    planets: save.stats.planets,
  })) {
    award(id);
  }

  const ladder = ladderById(s.ladder);
  const ladderDone = !!ladder && won && s.index === ladder.count && before < ladder.count;
  const next = ladder && won && s.index < ladder.count ? ladderLevel(save.name, ladder, s.index + 1) : null;
  const earned = earnedThisRun;
  pendingResult = () => {
    setScreen("result");
    menu.showResult({ spec: s, ticks, previousBest, newRecord, place, riders: (runs?.length ?? 0) + 1, earned, next, ladderDone });
  };
  resultIn = 1.4;
}

/** Live race standing for the HUD. */
function raceLines(): string[] {
  if (!spec?.race || game.mode !== "play") return [];
  const x = game.state.x;
  let ahead = 0;
  for (const p of game.pack) if (p.state.status === FINISHED || (p.state.status === RUNNING && p.state.x > x)) ahead++;
  const out = game.pack.filter((p) => p.state.status === CRASHED).length;
  return [`position ${ahead + 1} of ${game.pack.length + 1}${out ? `   (${out} AI crashed)` : ""}`];
}

// ---- menus ----
const host: MenuHost = {
  get save() {
    return save;
  },
  dev: DEV,
  persist() {
    storeSave(save);
    applyOptions();
  },
  play: startLevel,
  resume() {
    menu.hide();
    setScreen("playing");
  },
  restart: beginRun,
  quit: toMenu,
  watch(what) {
    const r = what === "best" ? game.best : what === "last" ? game.last : solution;
    if (!r || !spec) return;
    menu.hide();
    resultIn = -1;
    const label = what === "best" ? "YOUR BEST RUN" : what === "last" ? "REPLAY" : spec.race ? "FASTEST AI RIDER" : "A WAY THROUGH (solver, with rewinds)";
    game.watch(r, `${label}      R to ride`);
    setScreen("playing");
  },
  available(what) {
    return what === "best" ? game.best !== null : what === "last" ? game.last !== null : solution !== null;
  },
  resetProgress() {
    const fresh = newSave(save.name);
    fresh.options = save.options;
    save = fresh;
    storeSave(save);
    try {
      for (const k of Object.keys(localStorage)) if (k.startsWith("gravity.best.") || k.startsWith("gravity.level.")) localStorage.removeItem(k);
    } catch {
      // storage unavailable
    }
  },
};
const menu = new Menu(host);

/** Back to the main menu, with the AI riding an easy track behind it. */
function toMenu(): void {
  builder = null;
  ahead = null;
  spec = null;
  level = null;
  solution = null;
  resultIn = -1;
  renderer.busyText = "";
  setScreen("menu");
  startDemo();
  menu.showMain();
}

function startDemo(): void {
  setWorld("earth");
  game.cfg = defaultConfig;
  const track = generateTrack({ seed: hashText(save.name) % 1000, difficulty: 0.1, length: 500 });
  game.loadTrack(track);
  renderer.resetCamera();
  effects.clear();
  if (!rider) return;
  const run = runEpisode(track, defaultConfig, rider, true);
  game.watch({ trackId: game.trackId, cfg: defaultConfig, inputs: run.inputs!, ticks: run.ticks, hash: 0 }, "");
}

keyboard.onRestart = () => {
  if (screen === "playing" && spec) beginRun();
};
keyboard.onKey = (code) => {
  if (screen !== "playing") return;
  if (code === "KeyM") {
    save.options.sound = !save.options.sound;
    host.persist();
  } else if (code === "Escape" || code === "KeyP") {
    if (game.mode === "replay") beginRun();
    else if (spec) {
      setScreen("paused");
      menu.showPause(spec);
    }
  }
};
window.addEventListener("keydown", (e) => {
  // Browsers only allow sound after a key press or click.
  audio.unlock();
  if (e.code === "Escape" && screen === "loading") toMenu();
  // on the result screen R retries without reaching for the mouse
  if (e.code === "KeyR" && screen === "result") beginRun();
});
window.addEventListener("pointerdown", () => audio.unlock());
// pause when the window loses focus mid-ride
window.addEventListener("blur", () => {
  if (screen === "playing" && spec && game.mode === "play" && game.started && game.state.status === RUNNING) {
    setScreen("paused");
    menu.showPause(spec);
  }
});

// ---- dev mode: the tuning panel ----
if (DEV) {
  void import("./ui/tuning").then(({ createTuningPanel, loadConfig, loadLevel, saveLevel }) => {
    baseCfg = loadConfig();
    const devLevel = loadLevel();
    const playDevLevel = () => {
      save.custom = { difficulty: devLevel.difficulty, length: devLevel.length, planet: "earth", variant: devLevel.seed };
      startLevel(customLevel(save.name, save.custom, baseCfg));
    };
    const gui = createTuningPanel(baseCfg, devLevel, playDevLevel, (geometry) => {
      if (screen !== "playing") return;
      if (geometry) beginRun();
      else game.markConfigChanged();
    });
    saveLevel(devLevel);
    gui.domElement.style.zIndex = "30";
  });
}

applyOptions();
toMenu();

let last = performance.now();
let lastTick = 0;
function frame(now: number): void {
  const dt = (now - last) / 1000;
  last = now;
  buildSlice();
  if (screen !== "menu") buildAhead();

  const live = screen === "playing" || screen === "result" || screen === "menu";
  const alpha = live ? game.update(dt, screen === "playing" ? keyboard.mask : 0) : 1;
  // the demo ride behind the menu loops
  if (screen === "menu" && game.mode !== "replay" && rider) startDemo();

  // any restart rewinds the tick counter; snap the camera back to the start
  if (game.state.tick < lastTick) {
    renderer.resetCamera();
    effects.clear();
    audio.reset();
    tracker.reset();
    earnedThisRun = [];
  }
  lastTick = game.state.tick;

  const mine = game.mode === "play" && screen === "playing";
  for (const e of game.events) {
    if (screen !== "menu") audio.onEvent(e);
    effects.onEvent(e, game);
    if (mine && e.type === "crash") onCrash();
    if (mine && e.type === "finish") onFinish();
  }
  game.events.length = 0;

  if (resultIn > 0 && screen === "playing") {
    resultIn -= dt;
    if (resultIn <= 0 && pendingResult) pendingResult();
  }
  renderer.hudLines = raceLines();
  if (screen === "playing") audio.update(game, dt);
  effects.update(game, live ? dt : 0);
  renderer.draw(game, alpha, live ? dt : 0);
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);

// Handy for poking at the game from the browser console.
Object.assign(window, { game, audio, GameAudio, replay: { decodeReplay, encodeReplay, verifyReplay } });
