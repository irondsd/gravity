// Live tuning panel for bike parameters. Changes apply immediately and persist in localStorage.
import GUI from "lil-gui";
import { CONFIG_LIMITS, defaultConfig, sanitizeConfig, type BikeConfig } from "../sim";

const STORAGE_KEY = "gravity.config.v2";
const LEVEL_KEY = "gravity.level.v1";

export interface LevelSettings {
  track: "generated" | "test";
  seed: number;
  /** 0..100 */
  difficulty: number;
  length: number;
}

const defaultLevel: LevelSettings = { track: "generated", seed: 1, difficulty: 30, length: 400 };

/** Level choice: saved settings, overridden by a shared link like #seed=7&d=60&len=400. */
export function loadLevel(): LevelSettings {
  const level = { ...defaultLevel };
  try {
    const saved = JSON.parse(localStorage.getItem(LEVEL_KEY) ?? "{}") as Partial<LevelSettings>;
    if (saved.track === "generated" || saved.track === "test") level.track = saved.track;
    if (Number.isFinite(saved.seed)) level.seed = saved.seed!;
    if (Number.isFinite(saved.difficulty)) level.difficulty = saved.difficulty!;
    if (Number.isFinite(saved.length)) level.length = saved.length!;
  } catch {
    // defaults are fine
  }
  const q = new URLSearchParams(location.hash.slice(1));
  const num = (k: string) => (q.has(k) && Number.isFinite(Number(q.get(k))) ? Number(q.get(k)) : null);
  const seed = num("seed");
  if (seed !== null) {
    level.track = "generated";
    level.seed = seed;
    level.difficulty = num("d") ?? level.difficulty;
    level.length = num("len") ?? level.length;
  }
  return sanitizeLevel(level);
}

function sanitizeLevel(level: LevelSettings): LevelSettings {
  level.seed = Math.max(0, Math.min(999999, Math.floor(level.seed)));
  level.difficulty = Math.max(0, Math.min(100, Math.round(level.difficulty)));
  level.length = Math.max(150, Math.min(2000, Math.round(level.length / 50) * 50));
  return level;
}

export function saveLevel(level: LevelSettings): void {
  sanitizeLevel(level);
  try {
    localStorage.setItem(LEVEL_KEY, JSON.stringify(level));
  } catch {
    // storage unavailable
  }
  const hash = level.track === "generated" ? `#seed=${level.seed}&d=${level.difficulty}&len=${level.length}` : "#";
  history.replaceState(null, "", hash);
}


type Key = keyof BikeConfig;

const GROUPS: [string, Key[]][] = [
  ["Lean control", ["leanSpeedAir", "leanSpeedGround", "leanTorque", "leanTorqueAir", "leanGain", "airStability", "groundStability", "wheelieStability", "leanRate"]],
  ["Engine & brakes", ["engineTorque", "maxWheelSpin", "driveReaction", "brakeRear", "brakeFront"]],
  ["Suspension & landing", ["suspK", "suspDamp", "reboundDamp", "suspTravel", "suspStopK", "lateralK", "lateralDamp", "landingScrub", "landingBounce"]],
  ["Tires", ["tireMu", "tireK", "tireDamp", "tireStickK", "tireStickDamp"]],
  ["Mass & gravity", ["gravity", "chassisMass", "chassisInertia", "wheelMass", "wheelInertia"]],
  ["Geometry", ["wheelRadius", "rearAnchorX", "rearAnchorY", "frontAnchorX", "frontAnchorY", "frontAxisX", "frontAxisY"]],
  ["Head & crash", ["headHitSpeed", "headDamageMax", "headRecover", "headX", "headY", "headRadius", "headLeanShift"]],
  ["Body & fender", ["bodyK", "bodyDamp", "bodyMu", "fenderK", "fenderDamp", "fenderBreak", "fenderHitSpeed"]],
];

/** Saved tuning (only the values that differ from the defaults), clamped to safe ranges. */
export function loadConfig(): BikeConfig {
  try {
    return sanitizeConfig(JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "{}"));
  } catch {
    return { ...defaultConfig };
  }
}

function saveConfig(cfg: BikeConfig): void {
  const diff: Partial<BikeConfig> = {};
  for (const k of Object.keys(defaultConfig) as Key[]) if (cfg[k] !== defaultConfig[k]) diff[k] = cfg[k];
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(diff));
  } catch {
    // storage unavailable; tuning still works for this session
  }
}

export function createTuningPanel(
  cfg: BikeConfig,
  level: LevelSettings,
  onLevelChange: () => void,
  onChange: (geometry: boolean) => void,
): GUI {
  const gui = new GUI({ title: "Gravity", width: 300 });

  const lf = gui.addFolder("Level");
  const levelChanged = () => {
    saveLevel(level);
    lf.controllers.forEach((c) => c.updateDisplay());
    onLevelChange();
  };
  lf.add(level, "track", ["generated", "test"]).onChange(levelChanged);
  lf.add(level, "seed", 0, 999999, 1).onFinishChange(levelChanged);
  lf.add(level, "difficulty", 0, 100, 1).onFinishChange(levelChanged);
  lf.add(level, "length", 150, 2000, 50).onFinishChange(levelChanged);
  lf.add(
    {
      random: () => {
        level.track = "generated";
        level.seed = Math.floor(Math.random() * 1000000);
        levelChanged();
      },
    },
    "random",
  ).name("Random seed");

  const save = () => saveConfig(cfg);

  for (const [name, keys] of GROUPS) {
    const folder = gui.addFolder(name);
    for (const k of keys) {
      const [min, max] = CONFIG_LIMITS[k];
      folder.add(cfg, k, min, max).onChange(() => {
        save();
        onChange(name === "Geometry");
      });
    }
    folder.close();
  }

  gui.add(
    {
      reset: () => {
        Object.assign(cfg, defaultConfig);
        save();
        gui.controllersRecursive().forEach((c) => c.updateDisplay());
        onChange(true);
      },
    },
    "reset",
  ).name("Reset to defaults");
  gui.add(
    {
      copy: () => {
        void navigator.clipboard?.writeText(JSON.stringify(cfg, null, 2));
      },
    },
    "copy",
  ).name("Copy config as JSON");
  return gui;
}
