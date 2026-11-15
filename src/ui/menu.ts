// Menus: plain DOM laid over the game canvas. Arrow keys move, Enter picks, Esc goes back.
import { ACHIEVEMENTS, iconSvg, type Achievement } from "../app/achievements";
import { CUSTOM_LENGTH, customLevel, ladderById, ladderLevel, type Ladder, type LevelSpec } from "../app/modes";
import { PLANETS } from "../app/planets";
import { OPPONENTS } from "../app/race";
import { cleanName, NAME_MAX, randomName, type Options, type SaveData } from "../app/save";
import { formatTime } from "../app/format";
import { isTouch } from "../game/input";
import { themeById } from "../render/themes";

/** What the menus need from the game. */
export interface MenuHost {
  save: SaveData;
  /** Developer mode: every level is unlocked. */
  dev: boolean;
  /** Save the profile and apply any changed options. */
  persist(): void;
  play(spec: LevelSpec): void;
  resume(): void;
  restart(): void;
  quit(): void;
  watch(what: "best" | "last" | "solution"): void;
  available(what: "best" | "last" | "solution"): boolean;
  resetProgress(): void;
}

export interface ResultInfo {
  spec: LevelSpec;
  ticks: number;
  previousBest: number | null;
  newRecord: boolean;
  /** Race only: place taken and number of riders including the player. */
  place: number | null;
  riders: number;
  earned: Achievement[];
  /** The level after this one, if there is one and it is unlocked. */
  next: LevelSpec | null;
  /** True when this finish completed the whole ladder. */
  ladderDone: boolean;
}

type Child = HTMLElement | string | null | false;

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls = "", ...children: Child[]): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (cls) node.className = cls;
  for (const c of children) if (c) node.append(c);
  return node;
}

function button(label: string, hint: string, action: () => void, cls = ""): HTMLButtonElement {
  // a hint that only names a key is hidden on touch screens
  const key = /^(Esc|Enter|R)$/.test(hint);
  const b = el("button", `item ${cls}`.trim(), el("span", "", label), hint ? el("span", key ? "hint key" : "hint", hint) : null);
  b.type = "button";
  b.addEventListener("click", action);
  return b;
}

const ORDINALS = ["1st", "2nd", "3rd"];
const ordinal = (n: number) => ORDINALS[n - 1] ?? `${n}th`;

export class Menu {
  private root = el("div");
  private toasts = el("div");
  /** What Esc does on the current screen. */
  private back: (() => void) | null = null;
  /** The key press that opened a screen must not also act on it. */
  private fresh = false;

  constructor(private host: MenuHost) {
    this.root.id = "ui";
    this.toasts.id = "toasts";
    document.body.append(this.root, this.toasts);
    window.addEventListener("keydown", (e) => this.onKey(e));
  }

  get open(): boolean {
    return this.root.classList.contains("open");
  }

  hide(): void {
    this.root.classList.remove("open");
    this.root.replaceChildren();
    this.back = null;
    (document.activeElement as HTMLElement | null)?.blur?.();
  }

  private show(panel: HTMLElement, back: (() => void) | null, focus?: HTMLElement | null, light = false): void {
    this.root.replaceChildren(panel);
    this.root.classList.add("open");
    this.root.classList.toggle("light", light);
    this.root.scrollTop = 0;
    this.back = back;
    this.fresh = true;
    setTimeout(() => (this.fresh = false), 0);
    const target = focus ?? panel.querySelector<HTMLElement>("button:not(:disabled), input");
    target?.focus({ preventScroll: false });
  }

  private focusables(): HTMLElement[] {
    return [...this.root.querySelectorAll<HTMLElement>("button:not(:disabled), input")];
  }

  private onKey(e: KeyboardEvent): void {
    if (!this.open || this.fresh) return;
    const active = document.activeElement as HTMLElement | null;
    const typing = active instanceof HTMLInputElement && active.type === "text";
    if (e.code === "Escape") {
      e.preventDefault();
      if (typing) active.blur();
      this.back?.();
      return;
    }
    const dir = { ArrowUp: [0, -1], ArrowDown: [0, 1], ArrowLeft: [-1, 0], ArrowRight: [1, 0] }[e.code];
    if (!dir) return;
    const horizontal = dir[0] !== 0;
    // left/right belong to sliders and text while they have focus
    if (horizontal && active instanceof HTMLInputElement) return;
    e.preventDefault();
    const all = this.focusables();
    if (!active || !all.includes(active)) {
      all[0]?.focus();
      return;
    }
    // move to the nearest control in that direction
    const from = active.getBoundingClientRect();
    const fx = from.left + from.width / 2;
    const fy = from.top + from.height / 2;
    let best: HTMLElement | null = null;
    let bestScore = Infinity;
    for (const c of all) {
      if (c === active) continue;
      const r = c.getBoundingClientRect();
      const dx = r.left + r.width / 2 - fx;
      const dy = r.top + r.height / 2 - fy;
      const along = dx * dir[0]! + dy * dir[1]!;
      const across = Math.abs(dx * dir[1]!) + Math.abs(dy * dir[0]!);
      if (along < 4) continue;
      // in a column of full-width rows, sideways offset should not matter much
      const score = along + across * (horizontal ? 3 : 0.35);
      if (score < bestScore) {
        bestScore = score;
        best = c;
      }
    }
    best?.focus();
    best?.scrollIntoView({ block: "nearest" });
  }

  // ---- main menu ----

  showMain(): void {
    const { save } = this.host;
    const earned = Object.keys(save.achievements).length;
    const done = (id: string) => save.progress[id] ?? 0;
    const list = el("div", "list cols");

    // Continue: the next unfinished level of the mode last played (or of Standard)
    const std = ladderById("standard")!;
    const recent = ladderById(save.lastLadder);
    const last = recent && done(recent.id) < recent.count ? recent : std;
    if (save.stats.finishes > 0 && done(last.id) < last.count) {
      const n = done(last.id) + 1;
      list.append(button("Continue", `${last.title} · ${last.race ? "race" : "level"} ${n}`, () => this.host.play(ladderLevel(save.name, last, n)), "primary"));
    }
    list.append(
      button("Standard", `${done("standard")} of ${std.count} levels`, () => this.showLevels(std, () => this.showMain())),
      button("Planets", "Moon · Mars · Mercury", () => this.showWorlds("light")),
      button("Super-Earths", "2× · 3× · 5× · 10× gravity", () => this.showWorlds("heavy")),
      button("Race against AI", "easy · medium · hard", () => this.showRaces()),
      button("Custom track", "pick difficulty, length and world", () => this.showCustom()),
    );
    if (earned > 0) list.append(button("Achievements", `${earned} earned`, () => this.showAchievements()));
    list.append(button("Options", "", () => this.showOptions(() => this.showMain())));

    const tagline = el("p", "tagline", "Riding as ", el("b", "", save.name), ". Flip the bike and you start over.");
    this.show(el("div", "panel", el("h1", "logo", "GRAVITY"), tagline, list), null, null, true);
  }

  // ---- level select ----

  private showLevels(ladder: Ladder, back: () => void): void {
    const { save, dev } = this.host;
    const done = save.progress[ladder.id] ?? 0;
    const info = el("p", "info");
    const grid = el("div", "grid");
    let focus: HTMLElement | null = null;
    const word = ladder.race ? "Race" : "Level";
    for (let n = 1; n <= ladder.count; n++) {
      const spec = ladderLevel(save.name, ladder, n);
      const tile = el("button", "tile", String(n));
      tile.type = "button";
      const record = save.records[spec.id];
      if (n <= done) tile.classList.add("done");
      if (n === done + 1) {
        tile.classList.add("next");
        focus = tile;
      }
      tile.disabled = !dev && n > done + 1;
      const describe = () => {
        const parts = [`${word} ${n}`, `difficulty ${Math.round(spec.params.difficulty * 100)}`, `${spec.params.length} m`];
        if (record !== undefined) parts.push(`best ${formatTime(record)}`);
        info.textContent = parts.join("  ·  ");
      };
      tile.addEventListener("focus", describe);
      tile.addEventListener("mouseenter", describe);
      tile.addEventListener("click", () => this.host.play(spec));
      tile.setAttribute("aria-label", `${word} ${n}${n <= done ? ", finished" : ""}`);
      grid.append(tile);
    }
    const sub = ladder.race
      ? `${done} of ${ladder.count} won. Win a race to unlock the next one.`
      : `${done} of ${ladder.count} finished. Finish a level to unlock the next one.`;
    const panel = el("div", "panel wide", el("h2", "", ladder.title), el("p", "sub", sub), grid, info, button("Back", "Esc", back, "back"));
    this.show(panel, back, focus ?? grid.querySelector<HTMLElement>("button:not(:disabled)"));
  }

  // ---- planets and super-earths ----

  private showWorlds(group: "light" | "heavy"): void {
    const { save } = this.host;
    const back = () => this.showMain();
    const again = () => this.showWorlds(group);
    const cards = el("div", "cards");
    for (const p of PLANETS.filter((w) => w.group === group)) {
      const ladder = ladderById(p.id)!;
      const t = themeById(p.theme);
      const swatch = el("div", "swatch");
      swatch.style.background = `linear-gradient(180deg, ${t.skyTop}, ${t.skyMid} 45%, ${t.skyBottom} 62%, ${t.hillMid} 63%, ${t.groundTop})`;
      const card = el(
        "button",
        "item card",
        swatch,
        el("span", "name", p.name),
        el("span", "blurb", p.blurb),
        el("span", "prog", `${save.progress[p.id] ?? 0} of ${ladder.count} levels`),
      );
      card.type = "button";
      card.addEventListener("click", () => this.showLevels(ladder, again));
      cards.append(card);
    }
    const title = group === "light" ? "Planets" : "Super-Earths";
    const sub =
      group === "light"
        ? "Lighter gravity: the bike floats, jumps go on forever, and tracks are twice as long."
        : "Heavier gravity: jumps are short, landings are brutal, and the engine is beefed up to cope.";
    this.show(el("div", "panel wide", el("h2", "", title), el("p", "sub", sub), cards, button("Back", "Esc", back, "back")), back);
  }

  // ---- races ----

  private showRaces(): void {
    const { save } = this.host;
    const back = () => this.showMain();
    const again = () => this.showRaces();
    const text = {
      easy: "One AI rider, held back to a gentle pace.",
      medium: "Three AI riders at a brisk pace.",
      hard: "Ten AI riders, the best of them flat out.",
    };
    const cards = el("div", "cards");
    for (const tier of ["easy", "medium", "hard"] as const) {
      const ladder = ladderById(`race-${tier}`)!;
      const card = el(
        "button",
        "item card",
        el("span", "name", tier[0]!.toUpperCase() + tier.slice(1)),
        el("span", "blurb", text[tier]),
        el("span", "prog", `${save.progress[ladder.id] ?? 0} of ${ladder.count} won · ${OPPONENTS[tier].length} rider${OPPONENTS[tier].length > 1 ? "s" : ""}`),
      );
      card.type = "button";
      card.addEventListener("click", () => this.showLevels(ladder, again));
      cards.append(card);
    }
    const sub = "The AI sees one screen ahead, like you, and has never seen the track. It starts when you do. Finish first to win.";
    this.show(el("div", "panel wide", el("h2", "", "Race against AI"), el("p", "sub", sub), cards, button("Back", "Esc", back, "back")), back);
  }

  // ---- custom track ----

  private slider(label: string, min: number, max: number, step: number, value: number, format: (v: number) => string, onChange: (v: number) => void): HTMLElement {
    const input = el("input");
    input.type = "range";
    input.min = String(min);
    input.max = String(max);
    input.step = String(step);
    input.value = String(value);
    input.setAttribute("aria-label", label);
    const shown = el("span", "value", format(value));
    input.addEventListener("input", () => {
      shown.textContent = format(Number(input.value));
      onChange(Number(input.value));
    });
    return el("div", "field", el("label", "", label), input, shown);
  }

  private showCustom(): void {
    const { save } = this.host;
    const c = save.custom;
    const back = () => this.showMain();
    const worlds = PLANETS;
    const worldBtn = button("World", "", () => {
      const i = worlds.findIndex((w) => w.id === c.planet);
      c.planet = worlds[(i + 1) % worlds.length]!.id;
      update();
    });
    const record = el("p", "info");
    const update = () => {
      const w = worlds.find((p) => p.id === c.planet) ?? worlds[0]!;
      worldBtn.replaceChildren(el("span", "", "World"), el("span", "hint", `${w.name} · ${w.g}× gravity  (${isTouch() ? "tap" : "Enter"} to change)`));
      const best = save.records[customLevel(save.name, c).id];
      record.textContent = best !== undefined ? `Your best on this track: ${formatTime(best)}` : "You have not finished this track yet.";
      this.host.persist();
    };
    const list = el(
      "div",
      "list",
      this.slider("Difficulty", 0, 100, 1, c.difficulty, String, (v) => {
        c.difficulty = v;
        update();
      }),
      this.slider("Length", CUSTOM_LENGTH.min, CUSTOM_LENGTH.max, CUSTOM_LENGTH.step, c.length, (v) => `${v} m`, (v) => {
        c.length = v;
        update();
      }),
      worldBtn,
      button("New track", "same settings, different track", () => {
        c.variant++;
        update();
      }),
    );
    const play = button("Ride", "Enter", () => this.host.play(customLevel(save.name, c)), "primary");
    update();
    const note = el("p", "note", "Each track is checked by a solver before you ride. Very long or very hard tracks take a while to check, and a few cannot be proven passable; you will be told.");
    const panel = el("div", "panel", el("h2", "", "Custom track"), el("p", "sub", isTouch() ? "Build your own." : "Build your own. ← → move a slider."), list, record, note, el("div", "list", play, button("Back", "Esc", back)));
    this.show(panel, back, play);
  }

  // ---- achievements ----

  private badge(a: Achievement, when?: number): HTMLElement {
    const icon = el("span");
    icon.innerHTML = iconSvg(a);
    const date = when ? new Date(when).toLocaleDateString() : "";
    return el("div", "badge", icon.firstElementChild as HTMLElement, el("div", "", el("div", "t", a.title), el("div", "d", a.text + (date ? `  ·  ${date}` : ""))));
  }

  private showAchievements(): void {
    const { save } = this.host;
    const back = () => this.showMain();
    const mine = ACHIEVEMENTS.filter((a) => save.achievements[a.id] !== undefined).sort((a, b) => save.achievements[b.id]! - save.achievements[a.id]!);
    const badges = el("div", "badges", ...mine.map((a) => this.badge(a, save.achievements[a.id])));
    const sub = `${mine.length} earned so far. There are more to find.`;
    this.show(el("div", "panel wide", el("h2", "", "Achievements"), el("p", "sub", sub), badges, button("Back", "Esc", back, "back")), back);
  }

  // ---- options ----

  showOptions(back: () => void): void {
    const { save } = this.host;
    const o = save.options;
    const toggle = (label: string, key: keyof Omit<Options, "volume">, hint = "") => {
      const state = el("span", "state");
      const b = el("button", "item", el("span", "", label), hint ? el("span", "hint", hint) : null, state);
      b.type = "button";
      const paint = () => {
        state.textContent = o[key] ? "On" : "Off";
        state.classList.toggle("on", o[key]);
        if (hint) state.style.marginLeft = "0";
        b.setAttribute("aria-pressed", String(o[key]));
      };
      b.addEventListener("click", () => {
        o[key] = !o[key];
        paint();
        this.host.persist();
      });
      paint();
      return b;
    };

    const name = el("input");
    name.type = "text";
    name.maxLength = NAME_MAX;
    name.value = save.name;
    name.setAttribute("aria-label", "Rider name");
    name.spellcheck = false;
    const commit = () => {
      const cleaned = cleanName(name.value);
      if (!cleaned) {
        name.value = save.name;
        return;
      }
      name.value = cleaned;
      if (cleaned !== save.name) {
        save.name = cleaned;
        this.host.persist();
      }
    };
    name.addEventListener("change", commit);
    name.addEventListener("keydown", (e) => {
      if (e.code === "Enter") name.blur();
    });
    const dice = button("Random", "", () => {
      name.value = randomName();
      commit();
    }, "mini");
    const nameField = el("div", "field", el("label", "", "Rider name"), name, dice);

    let armed = false;
    const reset = button("Reset all progress", "", () => {
      if (!armed) {
        armed = true;
        reset.replaceChildren(el("span", "", "Really erase progress, records and achievements?"), el("span", "hint", "press again"));
        return;
      }
      this.host.resetProgress();
      this.showOptions(back);
    }, "danger");

    const panel = el(
      "div",
      "panel",
      el("h2", "", "Options"),
      el("p", "sub", "Saved on this device only."),
      el("div", "list", nameField),
      el("p", "note", "Your name is the seed for your tracks: the same name always gets the same levels. Change it and every level becomes a different track, with its own records. Your progress stays."),
      el(
        "div",
        "list",
        toggle("Blood", "blood"),
        toggle("Sound", "sound"),
        toggle("Screams and bone cracks", "screams"),
        this.slider("Volume", 0, 100, 5, Math.round(o.volume * 100), (v) => `${v}%`, (v) => {
          o.volume = v / 100;
          this.host.persist();
        }),
        toggle("Ghost of your best run", "ghost"),
        toggle("Camera shake", "shake"),
        toggle("Restart automatically after a crash", "autoRestart"),
      ),
      el("div", "spacer"),
      el("div", "list", reset, button("Back", "Esc", back)),
    );
    this.show(panel, back, panel.querySelector<HTMLElement>(".item:not(.mini)"));
  }

  // ---- pause ----

  showPause(spec: LevelSpec): void {
    const h = this.host;
    const resume = () => h.resume();
    const list = el("div", "list", button("Resume", "Esc", resume, "primary"), button("Restart", "R", () => h.restart()));
    if (h.available("best")) list.append(button("Watch your best run", "", () => h.watch("best")));
    if (h.available("solution")) list.append(button(spec.race ? "Watch the fastest AI ride it" : "Watch a way through", spec.race ? "" : "the solver's run", () => h.watch("solution")));
    list.append(
      button("Options", "", () => this.showOptions(() => this.showPause(spec))),
      button("Quit to menu", "", () => h.quit()),
    );
    this.show(el("div", "panel", el("h2", "", "Paused"), el("p", "sub", spec.title), list), resume, null, true);
  }

  // ---- result ----

  showResult(r: ResultInfo): void {
    const h = this.host;
    const won = r.place === null || r.place === 1;
    let title = "Finished";
    if (r.place !== null) title = r.place === 1 ? "You won!" : `${ordinal(r.place)} of ${r.riders}`;
    else if (r.ladderDone) title = "All done!";

    let line = "";
    if (r.previousBest === null) line = "First finish on this track.";
    else {
      const d = (r.ticks - r.previousBest) / 120;
      line = r.newRecord ? `New record, ${Math.abs(d).toFixed(2)} s faster than before.` : `${d.toFixed(2)} s off your best of ${formatTime(r.previousBest)}.`;
    }
    if (r.place !== null && !won) line += " Finish first to unlock the next race.";
    if (r.ladderDone && won) line += ` That was the last one in ${ladderById(r.spec.ladder)?.title ?? "this mode"}.`;

    const panel = el("div", "panel", el("h2", "", title), el("p", "sub", r.spec.title), el("div", "bigtime", formatTime(r.ticks)), el("p", "sub", line));
    if (r.earned.length) panel.append(el("div", "earned", el("span", "cap", r.earned.length > 1 ? "Achievements earned" : "Achievement earned"), ...r.earned.map((a) => this.badge(a))));
    const list = el("div", "list");
    const next = r.next;
    if (next) list.append(button(next.race ? "Next race" : "Next level", "Enter", () => h.play(next), "primary"));
    list.append(button(won ? "Retry to beat your time" : "Try again", "R", () => h.restart(), next ? "" : "primary"));
    if (h.available("last")) list.append(button("Watch that run", "", () => h.watch("last")));
    list.append(button("Menu", "Esc", () => h.quit()));
    panel.append(el("div", "spacer"), list);
    this.show(panel, () => h.quit(), null, true);
  }

  // ---- toasts ----

  toast(a: Achievement): void {
    const icon = el("span");
    icon.innerHTML = iconSvg(a, 40);
    const t = el("div", "toast", icon.firstElementChild as HTMLElement, el("div", "", el("div", "cap", "Achievement"), el("div", "t", a.title), el("div", "d", a.text)));
    t.setAttribute("role", "status");
    this.toasts.append(t);
    setTimeout(() => t.remove(), 5000);
  }
}
