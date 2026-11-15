// The player's profile: name, options, progress, records and achievements.
// Everything lives in one localStorage entry; nothing leaves the machine.

export interface Options {
  /** Blood and the red crash flash. */
  blood: boolean;
  sound: boolean;
  /** Pain screams and bone cracks (only heard when sound is on). */
  screams: boolean;
  /** 0..1 */
  volume: number;
  /** Show a ghost of your best run. */
  ghost: boolean;
  /** Camera shake on landings and crashes. */
  shake: boolean;
  /** Restart automatically a moment after a crash. */
  autoRestart: boolean;
}

export interface CustomSettings {
  /** 0..100 */
  difficulty: number;
  length: number;
  planet: string;
  /** Bumped by "new track" so the same settings can give a different track. */
  variant: number;
}

export interface Stats {
  crashes: number;
  finishes: number;
  /** Finishes in a row without a crash in between. */
  streak: number;
  /** Ids of the worlds a level has been finished on. */
  planets: string[];
}

export interface SaveData {
  v: 1;
  name: string;
  options: Options;
  /** Levels finished per ladder ("standard", "moon", "race-easy", ...): the next one to play is this + 1. */
  progress: Record<string, number>;
  /** Best finish time in ticks, by level id. */
  records: Record<string, number>;
  /** Crashes on a level since it was last finished, by level id. */
  fails: Record<string, number>;
  /** Achievement id -> when it was earned (ms since epoch). */
  achievements: Record<string, number>;
  stats: Stats;
  custom: CustomSettings;
  /** The ladder last played, for "Continue". */
  lastLadder: string;
}

const KEY = "gravity.save.v1";

const ADJECTIVES = ["Turbo", "Muddy", "Flying", "Reckless", "Dusty", "Lucky", "Rusty", "Midnight", "Wobbly", "Fearless", "Crooked", "Electric", "Grumpy", "Silent", "Wild", "Iron", "Rapid", "Sneaky", "Bouncy", "Cosmic"];
const NOUNS = ["Badger", "Piston", "Comet", "Otter", "Gasket", "Falcon", "Wrench", "Coyote", "Sprocket", "Moose", "Throttle", "Lizard", "Kickstand", "Raven", "Camshaft", "Walrus", "Clutch", "Hornet", "Axle", "Yeti"];

export function randomName(rand: () => number = Math.random): string {
  const pick = (list: string[]) => list[Math.floor(rand() * list.length)]!;
  return `${pick(ADJECTIVES)}${pick(NOUNS)}${10 + Math.floor(rand() * 90)}`;
}

export const NAME_MAX = 20;

/** Trim a typed name to something safe to show and to seed levels with. */
export function cleanName(name: string): string {
  return name.replace(/\s+/g, " ").trim().slice(0, NAME_MAX);
}

export const defaultOptions: Options = { blood: true, sound: true, screams: true, volume: 0.8, ghost: true, shake: true, autoRestart: true };

export function newSave(name = randomName()): SaveData {
  return {
    v: 1,
    name,
    options: { ...defaultOptions },
    progress: {},
    records: {},
    fails: {},
    achievements: {},
    stats: { crashes: 0, finishes: 0, streak: 0, planets: [] },
    custom: { difficulty: 30, length: 400, planet: "earth", variant: 0 },
    lastLadder: "standard",
  };
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

function numberMap(v: unknown): Record<string, number> {
  const out: Record<string, number> = {};
  if (isRecord(v)) for (const [k, n] of Object.entries(v)) if (typeof n === "number" && Number.isFinite(n) && n >= 0) out[k] = n;
  return out;
}

/** Turn whatever was stored into a complete, valid save: missing or broken parts fall back to defaults. */
export function parseSave(text: string | null, fallbackName = randomName()): SaveData {
  const save = newSave(fallbackName);
  let raw: unknown;
  try {
    raw = JSON.parse(text ?? "null");
  } catch {
    return save;
  }
  if (!isRecord(raw) || raw.v !== 1) return save;
  if (typeof raw.name === "string" && cleanName(raw.name)) save.name = cleanName(raw.name);
  if (isRecord(raw.options)) {
    const o = raw.options;
    for (const k of ["blood", "sound", "screams", "ghost", "shake", "autoRestart"] as const) if (typeof o[k] === "boolean") save.options[k] = o[k];
    if (typeof o.volume === "number" && Number.isFinite(o.volume)) save.options.volume = Math.max(0, Math.min(1, o.volume));
  }
  save.progress = numberMap(raw.progress);
  save.records = numberMap(raw.records);
  save.fails = numberMap(raw.fails);
  save.achievements = numberMap(raw.achievements);
  if (isRecord(raw.stats)) {
    const s = raw.stats;
    for (const k of ["crashes", "finishes", "streak"] as const) if (typeof s[k] === "number" && Number.isFinite(s[k])) save.stats[k] = Math.max(0, Math.floor(s[k]));
    if (Array.isArray(s.planets)) save.stats.planets = s.planets.filter((p): p is string => typeof p === "string");
  }
  if (isRecord(raw.custom)) {
    const c = raw.custom;
    if (typeof c.difficulty === "number") save.custom.difficulty = Math.max(0, Math.min(100, Math.round(c.difficulty)));
    if (typeof c.length === "number") save.custom.length = Math.max(150, Math.min(2000, Math.round(c.length / 50) * 50));
    if (typeof c.planet === "string") save.custom.planet = c.planet;
    if (typeof c.variant === "number") save.custom.variant = Math.max(0, Math.floor(c.variant));
  }
  if (typeof raw.lastLadder === "string") save.lastLadder = raw.lastLadder;
  return save;
}

export function loadSave(): SaveData {
  try {
    return parseSave(localStorage.getItem(KEY));
  } catch {
    return newSave();
  }
}

export function storeSave(save: SaveData): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(save));
  } catch {
    // storage unavailable or full: the game still works, it just forgets on reload
  }
}

/** FNV-1a hash of a string to an unsigned 32-bit number. Levels are seeded from the player's name with this. */
export function hashText(text: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}
