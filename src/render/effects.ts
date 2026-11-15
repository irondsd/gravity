// Cosmetic effects: dust, dirt, blood, confetti, camera shake. Driven by sim events and
// state, never the other way round, so randomness and real time are fine here.
import { CRASHED, heightAt, IN_THROTTLE, RUNNING, type SimEvent, type Track } from "../sim";
import type { Game } from "../game/game";
import { R_HEAD } from "../game/ragdoll";

const DUST = 0;
const DIRT = 1;
const BLOOD = 2;
const STAIN = 3;
const CONFETTI = 4;
const DEBRIS = 5;
const MAX_PARTICLES = 1200;

interface Particle {
  kind: number;
  x: number;
  y: number;
  vx: number;
  vy: number;
  age: number;
  life: number;
  size: number;
  rot: number;
  color: string;
}

const rand = (a: number, b: number) => a + Math.random() * (b - a);
const CONFETTI_COLORS = ["#ffd166", "#ef4b4b", "#7bd389", "#6ec6ff", "#f2e9e4"];
const BLOOD_COLORS = ["#b3121d", "#8f0d17", "#c81d25"];

export class Effects {
  private items: Particle[] = [];
  /** Camera shake amplitude in meters; decays on its own. */
  shake = 0;
  /** Red screen flash on a crash, 1 fading to 0. */
  flash = 0;
  private sinceCrash = 0;
  /** Blood and the red flash; off for the squeamish. */
  gore = true;
  dustColor = "#cdbfd0";
  dirtColor = "#5a4f6e";
  private emitDebt = 0;

  /** Remove any blood already on screen (when the option is switched off mid-game). */
  clearBlood(): void {
    this.items = this.items.filter((p) => p.kind !== BLOOD && p.kind !== STAIN);
    this.flash = 0;
  }

  clear(): void {
    this.items.length = 0;
    this.shake = 0;
    this.flash = 0;
    this.sinceCrash = 0;
  }

  private add(kind: number, x: number, y: number, vx: number, vy: number, life: number, size: number, color: string): void {
    if (this.items.length >= MAX_PARTICLES && kind !== BLOOD) return;
    this.items.push({ kind, x, y, vx, vy, age: 0, life, size, rot: rand(0, 6.28), color });
  }

  private dust(x: number, y: number, n: number, spread: number): void {
    for (let i = 0; i < n; i++) {
      this.add(DUST, x + rand(-0.15, 0.15), y + rand(0, 0.1), rand(-spread, spread), rand(0.2, 1.2), rand(0.4, 0.9), rand(0.08, 0.2), "");
    }
  }

  private blood(x: number, y: number, vx: number, vy: number, n: number, speed: number): void {
    if (!this.gore) return;
    for (let i = 0; i < n; i++) {
      const color = BLOOD_COLORS[(Math.random() * BLOOD_COLORS.length) | 0]!;
      this.add(BLOOD, x, y, vx + rand(-speed, speed), vy + rand(-0.3 * speed, speed), 4, rand(0.025, 0.06), color);
    }
  }

  onEvent(e: SimEvent, game: Game): void {
    const s = game.state;
    const cfg = game.simCfg;
    if (e.type === "land") {
      const wh = e.wheel === 0 ? s.rear : s.front;
      const k = Math.min(1, e.speed / 9);
      this.dust(wh.x, heightAt(game.track, wh.x), 3 + Math.round(9 * k), 1 + 2 * k);
      this.shake = Math.max(this.shake, 0.05 + 0.14 * k);
    } else if (e.type === "fenderBreak") {
      // the snapped fender flies off behind the bike
      const fx = s.x + s.rx * -0.66 - s.ry * 0.22;
      const fy = s.y + s.ry * -0.66 + s.rx * 0.22;
      this.add(DEBRIS, fx, fy, s.vx * 0.6 - rand(1, 3), s.vy * 0.5 + rand(2, 4), 6, 0.3, "#ef4b4b");
      this.dust(fx, fy - 0.1, 5, 1.5);
      this.shake = Math.max(this.shake, 0.12);
    } else if (e.type === "crash") {
      this.shake = 0.35;
      this.flash = this.gore ? 1 : 0;
      this.sinceCrash = 0;
      const head = game.ragdoll;
      const hx = head ? head.x[R_HEAD]! : s.x;
      const hy = head ? head.y[R_HEAD]! : s.y + cfg.headY;
      this.blood(hx, hy, s.vx * 0.5, s.vy * 0.3 + 2, 60, 4.5);
    } else if (e.type === "finish") {
      for (let i = 0; i < 90; i++) {
        const color = CONFETTI_COLORS[(Math.random() * CONFETTI_COLORS.length) | 0]!;
        this.add(CONFETTI, game.track.finishX + rand(-1, 3), heightAt(game.track, game.track.finishX) + rand(2.5, 4.5), rand(-2, 6), rand(1, 7), rand(3, 5), rand(0.05, 0.09), color);
      }
    }
  }

  /** Per-frame: continuous emitters and particle motion. */
  update(game: Game, dt: number): void {
    const s = game.state;
    const cfg = game.simCfg;
    const track = game.track;
    this.shake *= Math.exp(-dt * 9);
    this.flash = Math.max(0, this.flash - dt * 1.6);

    if (game.started && dt > 0) {
      this.emitDebt = Math.min(this.emitDebt + dt, 0.1);
      const R = cfg.wheelRadius;
      // Rear wheel throws dirt backward under power; sliding tires kick up dust.
      if (s.status === RUNNING && s.rear.grounded === 1) {
        const slip = Math.abs(s.rear.vx * s.rx + s.rear.vy * s.ry + s.rear.w * R);
        const power = game.lastInput & IN_THROTTLE ? Math.min(1, 0.2 + slip / 3) : 0;
        const n = Math.floor(power * 70 * this.emitDebt + Math.random());
        const gy = heightAt(track, s.rear.x);
        for (let i = 0; i < n; i++) {
          this.add(DIRT, s.rear.x - 0.1, gy + 0.03, s.vx * 0.35 - rand(1.5, 5) * power, rand(1, 4.5) * power, 1.2, rand(0.02, 0.045), this.dirtColor);
        }
      }
      for (const wh of [s.rear, s.front]) {
        if (wh.grounded === 0) continue;
        const slip = Math.abs(wh.vx * s.rx + wh.vy * s.ry + wh.w * R);
        if (slip > 3 && Math.random() < this.emitDebt * 40) this.dust(wh.x, heightAt(track, wh.x), 1, 1);
      }
      this.emitDebt = 0;

      // The rider keeps bleeding from the head for a moment after a crash.
      if (s.status === CRASHED && game.ragdoll) {
        this.sinceCrash += dt;
        if (this.sinceCrash < 1.6 && Math.random() < dt * 50) {
          const r = game.ragdoll;
          const vx = (r.x[R_HEAD]! - r.px[R_HEAD]!) * 120;
          const vy = (r.y[R_HEAD]! - r.py[R_HEAD]!) * 120;
          this.blood(r.x[R_HEAD]!, r.y[R_HEAD]!, vx * 0.6, vy * 0.6, 2, 1.4);
        }
      }
    }

    this.move(dt, track, cfg.gravity);
  }

  private move(dt: number, track: Track, gravity: number): void {
    const items = this.items;
    for (let i = items.length - 1; i >= 0; i--) {
      const p = items[i]!;
      if (p.kind === STAIN) continue;
      p.age += dt;
      let dead = p.age > p.life;
      if (p.kind === DUST) {
        p.vx *= Math.exp(-dt * 2.5);
        p.x += p.vx * dt;
        p.y += p.vy * dt;
        p.size += dt * 0.35;
      } else if (!dead && (p.vx !== 0 || p.vy !== 0 || (p.kind !== CONFETTI && p.kind !== DEBRIS))) {
        if (p.kind === DEBRIS) p.rot += dt * 11;
        if (p.kind === CONFETTI) {
          p.vx *= Math.exp(-dt * 1.5);
          p.vy = Math.max(p.vy - gravity * 0.35 * dt, -2.2);
          p.rot += dt * 9;
        } else {
          p.vy -= gravity * dt;
        }
        p.x += p.vx * dt;
        p.y += p.vy * dt;
        const ground = heightAt(track, p.x);
        if (p.y <= ground) {
          if (p.kind === DIRT) dead = true;
          else if (p.kind === BLOOD) {
            // splat: becomes a stain lying along the slope
            p.kind = STAIN;
            p.y = ground;
            p.size *= rand(1.3, 2.6);
            p.rot = Math.atan2(heightAt(track, p.x + 0.1) - heightAt(track, p.x - 0.1), 0.2);
          } else {
            p.y = ground + 0.01;
            p.vx = 0;
            p.vy = 0;
          }
        }
      }
      if (dead) {
        items[i] = items[items.length - 1]!;
        items.pop();
      }
    }
  }

  /** Things lying on or hugging the ground; drawn under the bike. */
  drawBack(ctx: CanvasRenderingContext2D): void {
    for (const p of this.items) {
      if (p.kind === STAIN) {
        ctx.fillStyle = p.color;
        ctx.beginPath();
        ctx.ellipse(p.x, p.y, p.size, p.size * 0.4, p.rot, 0, Math.PI * 2);
        ctx.fill();
      } else if (p.kind === DUST) {
        ctx.globalAlpha = 0.28 * (1 - p.age / p.life);
        ctx.fillStyle = this.dustColor;
        ctx.beginPath();
        ctx.arc(p.x, p.y, p.size, 0, Math.PI * 2);
        ctx.fill();
        ctx.globalAlpha = 1;
      }
    }
  }

  /** Things flying through the air; drawn over the bike. */
  drawFront(ctx: CanvasRenderingContext2D): void {
    for (const p of this.items) {
      if (p.kind === DIRT || p.kind === BLOOD) {
        ctx.fillStyle = p.color;
        ctx.beginPath();
        ctx.arc(p.x, p.y, p.size, 0, Math.PI * 2);
        ctx.fill();
      } else if (p.kind === DEBRIS) {
        ctx.save();
        ctx.translate(p.x, p.y + 0.04);
        ctx.rotate(p.rot);
        ctx.fillStyle = p.color;
        ctx.beginPath();
        ctx.moveTo(-p.size, 0.04);
        ctx.lineTo(p.size, 0);
        ctx.lineTo(p.size * 0.8, -0.06);
        ctx.lineTo(-p.size * 0.9, -0.03);
        ctx.fill();
        ctx.restore();
      } else if (p.kind === CONFETTI) {
        ctx.fillStyle = p.color;
        const w = p.size * (0.4 + 0.6 * Math.abs(Math.cos(p.rot)));
        ctx.fillRect(p.x - w, p.y - p.size * 0.6, w * 2, p.size * 1.2);
      }
    }
  }
}
