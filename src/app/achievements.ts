// Achievements: what they are, and the tracker that notices them during a run.
// The tracker is pure (it only reads sim state), so it can be tested headlessly.
import { CRASHED, RUNNING, TICK_DT, type SimState } from "../sim";

export interface Achievement {
  id: string;
  title: string;
  text: string;
  /** Inner SVG markup for a 48x48 icon, drawn on a round badge of `color`. */
  icon: string;
  color: string;
}

const W = `fill="none" stroke="#fff" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"`;
const F = `fill="#fff"`;
// little building blocks for the icons
const loop = (r: number, arrow: string) => `<path d="M24 ${24 - r}a${r} ${r} 0 1 1 -${r} ${r}" ${W}/><path d="${arrow}" ${W}/>`;
const bikeGlyph = `<circle cx="15" cy="30" r="5" ${W}/><circle cx="33" cy="30" r="5" ${W}/><path d="M15 30l7-9h7l4 9M22 21l-2-4" ${W}/>`;
const star = `<path d="M24 11l3.8 8.2 8.9 1-6.6 6.1 1.8 8.8L24 30.7l-7.9 4.4 1.8-8.8-6.6-6.1 8.9-1z" ${F}/>`;
const flag = `<path d="M16 37V12" ${W}/><path d="M16 13h17l-4 6 4 6H16z" ${F}/>`;
const robot = `<rect x="14" y="17" width="20" height="16" rx="3" ${W}/><circle cx="20" cy="25" r="2" ${F}/><circle cx="28" cy="25" r="2" ${F}/><path d="M24 17v-5M21 12h6" ${W}/>`;

export const ACHIEVEMENTS: Achievement[] = [
  { id: "backflip", title: "Backflip", text: "Land a full backward rotation.", color: "#2f7fc1", icon: loop(10, "M9 21l5 4 4-5") },
  { id: "frontflip", title: "Frontflip", text: "Land a full forward rotation.", color: "#3aa08a", icon: `<g transform="translate(48 0) scale(-1 1)">${loop(10, "M9 21l5 4 4-5")}</g>` },
  { id: "double", title: "Double flip", text: "Two full rotations in one jump, and ride away.", color: "#8a5cd0", icon: loop(12, "M7 21l5 4 4-5") + `<circle cx="24" cy="24" r="5" ${W}/>` },
  { id: "triple", title: "Triple flip", text: "Three full rotations in one jump. Gravity optional.", color: "#c2478f", icon: loop(13, "M6 21l5 4 4-5") + `<circle cx="24" cy="24" r="7" ${W}/><circle cx="24" cy="24" r="2" ${F}/>` },
  { id: "wheelie", title: "Wheelie king", text: "Ride on the back wheel for 5 seconds.", color: "#d98a2b", icon: `<g transform="rotate(-32 15 30)">${bikeGlyph}</g>` },
  { id: "airtime", title: "Frequent flyer", text: "Stay in the air for 4 seconds and land it.", color: "#4a8fd6", icon: `<path d="M8 28c6-10 14-14 32-14-6 4-9 8-11 14l-6-3-4 6-2-6z" ${F}/>` },
  { id: "speed", title: "Speed demon", text: "Reach 110 km/h in standard gravity.", color: "#d6453d", icon: `<path d="M10 32a14 14 0 1 1 28 0" ${W}/><path d="M24 32l8-11" ${W}/><circle cx="24" cy="32" r="2.5" ${F}/>` },
  { id: "persist", title: "Stubborn", text: "Finish a level after 10 or more failed attempts.", color: "#8d6e4f", icon: `<path d="M13 35V19a5 5 0 0 1 10 0v8M23 27v-4a4 4 0 0 1 8 0v4M31 27a3 3 0 0 1 6 0v3a8 8 0 0 1-8 8h-8" ${W}/>` },
  { id: "firsttry", title: "First try", text: "Finish a standard level past 30 on your first attempt.", color: "#3f9b52", icon: `<path d="M13 25l8 8 15-17" ${W}/>` },
  { id: "record", title: "Personal best", text: "Beat your own record on a level.", color: "#c9a227", icon: `<circle cx="24" cy="26" r="11" ${W}/><path d="M24 19v7l5 3M20 11h8" ${W}/>` },
  { id: "std10", title: "Getting the hang of it", text: "Finish standard level 10.", color: "#5b7fa6", icon: flag },
  { id: "std50", title: "Halfway there", text: "Finish standard level 50.", color: "#7a5ea8", icon: flag + `<path d="M33 31h6M36 28v6" ${W}/>` },
  { id: "std100", title: "Gravity defied", text: "Finish all 100 standard levels.", color: "#d4a017", icon: `<path d="M15 12h18v8a9 9 0 0 1-18 0zM24 29v6M17 37h14M15 15h-5c0 5 2 8 6 8M33 15h5c0 5-2 8-6 8" ${W}/>` },
  { id: "ai-easy", title: "Beat the rookie", text: "Win a race against the AI on easy.", color: "#4c9a6a", icon: robot },
  { id: "ai-medium", title: "Beat the pack", text: "Win a race against the AI on medium.", color: "#c98a2b", icon: robot + `<path d="M9 37h30" ${W}/>` },
  { id: "ai-hard", title: "Beat the swarm", text: "Win a race against ten AI riders on hard.", color: "#c9413d", icon: robot + `<path d="M9 37h30M11 12l4 3M37 12l-4 3" ${W}/>` },
  { id: "photo", title: "Photo finish", text: "Beat the AI by less than half a second.", color: "#5a6fd0", icon: `<rect x="10" y="17" width="28" height="19" rx="3" ${W}/><circle cx="24" cy="26" r="5" ${W}/><path d="M18 17l2-4h8l2 4" ${W}/>` },
  { id: "tourist", title: "Space tourist", text: "Finish a level on the Moon, Mars and Mercury.", color: "#6b6f8a", icon: `<circle cx="24" cy="24" r="8" ${W}/><ellipse cx="24" cy="24" rx="16" ry="5" transform="rotate(-20 24 24)" ${W}/>` },
  { id: "heavy", title: "Heavyweight", text: "Finish a level on every super-earth.", color: "#2f6b45", icon: `<path d="M14 36l3-17h14l3 17zM20 19a4 4 0 0 1 8 0" ${W}/><path d="M20 29h8" ${W}/>` },
  { id: "marathon", title: "Marathon", text: "Finish a 2000 m track.", color: "#b0553a", icon: `<path d="M8 34c6-12 10 4 16-8s10 4 16-8" ${W}/><circle cx="40" cy="18" r="2.5" ${F}/>` },
  { id: "hardhead", title: "Hard-headed", text: "Scrape your helmet on the ground and still finish.", color: "#9a4f6b", icon: `<path d="M11 30a13 13 0 0 1 26 0v3H11z" ${W}/><path d="M26 30h11M20 14l-2-4M28 14l2-4" ${W}/>` },
  { id: "fender", title: "Who needs a fender", text: "Finish with the rear fender snapped off.", color: "#7d6a55", icon: `<path d="M10 30c2-9 8-14 16-14M30 18l8 3M30 26l7 6" ${W}/>` },
  { id: "dummy", title: "Crash test dummy", text: "Crash 100 times.", color: "#b8a12e", icon: `<circle cx="24" cy="24" r="13" ${W}/><path d="M24 11v26M11 24h26" ${W}/><path d="M24 24V11a13 13 0 0 1 13 13zM24 24v13a13 13 0 0 1-13-13z" ${F}/>` },
  { id: "streak", title: "Clean streak", text: "Finish 5 levels in a row without crashing.", color: "#3b9aa8", icon: star },
  { id: "extreme", title: "Glutton for punishment", text: "Finish a custom track at difficulty 100.", color: "#8b2d2d", icon: `<path d="M24 9c2 7 9 9 9 18a9 9 0 0 1-18 0c0-4 2-6 4-8 0 4 2 5 3 5 0-6-1-10 2-15z" ${F}/>` },
];

export function achievementById(id: string): Achievement | undefined {
  return ACHIEVEMENTS.find((a) => a.id === id);
}

/** A complete SVG image for an achievement's badge. */
export function iconSvg(a: Achievement, size = 48): string {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 48 48"><circle cx="24" cy="24" r="23" fill="${a.color}"/><circle cx="24" cy="24" r="23" fill="none" stroke="rgba(255,255,255,0.35)" stroke-width="1.5"/>${a.icon}</svg>`;
}

const FULL_TURN = 2 * Math.PI * 0.9; // a little short of 360° still looks like a flip
const SETTLE_TICKS = 60; // must still be riding this long after a landing for it to count
const WHEELIE_TICKS = 5 * 120;
const AIR_TICKS = 4 * 120;
const SPEED = 110 / 3.6;

/** Watches one run tick by tick and reports the stunts in it. */
export class RunTracker {
  private rot = 0; // rotation accumulated in the current jump, radians (+ = backward)
  private air = 0; // ticks in the current jump
  private wheelie = 0;
  private pending: string[] = [];
  private pendingAt = -1;
  /** The helmet touched the ground at some point in this run. */
  headScraped = false;

  reset(): void {
    this.rot = 0;
    this.air = 0;
    this.wheelie = 0;
    this.pending = [];
    this.pendingAt = -1;
    this.headScraped = false;
  }

  /** Call once per sim tick, after it. Returns ids of stunt achievements completed on this tick. */
  tick(s: SimState, standardGravity = true): string[] {
    const out: string[] = [];
    if (s.status === CRASHED) {
      this.pending = [];
      return out;
    }
    if (s.status !== RUNNING) return out;
    if (s.headContact === 1) this.headScraped = true;

    const rear = s.rear.grounded === 1;
    const front = s.front.grounded === 1;
    if (!rear && !front) {
      this.rot += s.w * TICK_DT;
      this.air++;
    } else {
      if (this.air > 0) {
        const turns = Math.floor(Math.abs(this.rot) / FULL_TURN);
        if (turns >= 1) this.pending.push(this.rot > 0 ? "backflip" : "frontflip");
        if (turns >= 2) this.pending.push("double");
        if (turns >= 3) this.pending.push("triple");
        if (this.air >= AIR_TICKS) this.pending.push("airtime");
        if (this.pending.length) this.pendingAt = s.tick + SETTLE_TICKS;
      }
      this.rot = 0;
      this.air = 0;
    }
    // a landing counts once the rider has survived it for a moment
    if (this.pending.length && s.tick >= this.pendingAt) {
      out.push(...this.pending);
      this.pending = [];
    }

    if (rear && !front && s.vx > 3) {
      if (++this.wheelie === WHEELIE_TICKS) out.push("wheelie");
    } else if (front) this.wheelie = 0;
    // a short hop off a bump does not end a wheelie, but a long flight does
    else if (!rear && this.air > 30) this.wheelie = 0;

    // heavy worlds have beefed-up engines, so top speed only counts at home
    if (standardGravity && s.vx * s.vx + s.vy * s.vy >= SPEED * SPEED) out.push("speed");
    return out;
  }
}

/** What is known when a level is finished; everything `finishAchievements` needs. */
export interface FinishInfo {
  ladder: string;
  index: number;
  /** 0..1 */
  difficulty: number;
  length: number;
  ticks: number;
  /** Crashes on this level since it was last finished. */
  failsBefore: number;
  /** Best earlier time on this level, if any. */
  previousBest: number | null;
  /** Race result: place taken (1 = won) and how many ticks ahead of the fastest opponent; null outside races. */
  place: number | null;
  marginTicks: number | null;
  headScraped: boolean;
  fenderBroken: boolean;
  /** After counting this finish: */
  standardDone: number;
  streak: number;
  planets: string[];
}

/** Ids of every achievement this finish qualifies for (including ones already owned). */
export function finishAchievements(f: FinishInfo): string[] {
  const out: string[] = [];
  if (f.failsBefore >= 10) out.push("persist");
  if (f.ladder === "standard" && f.index >= 30 && f.failsBefore === 0 && f.previousBest === null) out.push("firsttry");
  if (f.previousBest !== null && f.ticks < f.previousBest) out.push("record");
  if (f.standardDone >= 10) out.push("std10");
  if (f.standardDone >= 50) out.push("std50");
  if (f.standardDone >= 100) out.push("std100");
  if (f.place === 1 && f.ladder.startsWith("race-")) {
    out.push(`ai-${f.ladder.slice(5)}`);
    if (f.marginTicks !== null && f.marginTicks < 60) out.push("photo");
  }
  const been = (ids: string[]) => ids.every((id) => f.planets.includes(id));
  if (been(["moon", "mars", "mercury"])) out.push("tourist");
  if (been(["super2", "super3", "super5", "super10"])) out.push("heavy");
  if (f.length >= 2000) out.push("marathon");
  if (f.headScraped) out.push("hardhead");
  if (f.fenderBroken) out.push("fender");
  if (f.streak >= 5) out.push("streak");
  if (f.ladder === "custom" && f.difficulty >= 1) out.push("extreme");
  return out;
}
