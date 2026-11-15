// Canvas renderer. Everything is drawn in code; there are no image files.
// Reads sim state only; nothing here feeds back into the simulation,
// so it is free to use trig, real time, and randomness.
import {
  CAUSE_CRUSHED,
  CAUSE_NECK,
  CRASHED,
  heightAt,
  segmentIndex,
  type BikeConfig,
  type SimState,
  type Track,
  type WheelState,
} from "../sim";
import type { Game } from "../game/game";
import * as RD from "../game/ragdoll";
import { J_ELBOW, J_FOOT, J_HAND, J_HEAD, J_HIP, J_KNEE, J_SHOULDER, JOINTS, riderPose } from "../game/rider";
import { formatTime } from "../app/format";
import type { Effects } from "./effects";
import { THEMES, type Theme } from "./themes";

const DEPTH_X = 0.28; // fake-3D: the track is a strip with this visual depth
const DEPTH_Y = 0.36;

const C = {
  tire: "#101017",
  rim: "#c9ccd6",
  frame: "#ef4b4b",
  frameDark: "#b93440",
  engine: "#343744",
  metal: "#9aa0ad",
  seat: "#1a1c25",
  jersey: "#2f7fc1",
  jerseyFar: "#205a8c",
  pants: "#262936",
  pantsFar: "#1b1d27",
  boot: "#0f1016",
  helmet: "#f4f1de",
  visor: "#22263a",
  text: "#f2e9e4",
};

interface View {
  x: number;
  y: number;
  rx: number;
  ry: number;
  lean: number;
  fender: boolean;
  rear: { x: number; y: number; angle: number };
  front: { x: number; y: number; angle: number };
}

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

function newView(): View {
  return { x: 0, y: 0, rx: 1, ry: 0, lean: 0, fender: true, rear: { x: 0, y: 0, angle: 0 }, front: { x: 0, y: 0, angle: 0 } };
}

function lerpWheel(out: View["rear"], a: WheelState, b: WheelState, t: number): void {
  out.x = lerp(a.x, b.x, t);
  out.y = lerp(a.y, b.y, t);
  // angle wraps in the sim; skip interpolation across the wrap
  out.angle = Math.abs(b.angle - a.angle) > 100 ? b.angle : lerp(a.angle, b.angle, t);
}

function fillView(v: View, prev: SimState, cur: SimState, alpha: number): void {
  v.x = lerp(prev.x, cur.x, alpha);
  v.y = lerp(prev.y, cur.y, alpha);
  const rx = lerp(prev.rx, cur.rx, alpha);
  const ry = lerp(prev.ry, cur.ry, alpha);
  const rl = Math.hypot(rx, ry) || 1;
  v.rx = rx / rl;
  v.ry = ry / rl;
  v.lean = lerp(prev.lean, cur.lean, alpha);
  v.fender = cur.fenderBroken === 0;
  lerpWheel(v.rear, prev.rear, cur.rear, alpha);
  lerpWheel(v.front, prev.front, cur.front, alpha);
}

export class Renderer {
  private ctx: CanvasRenderingContext2D;
  private camX = 0;
  private camY = 0;
  private zoomK = 1;
  private camInit = false;
  private view = newView();
  private ghostView = newView();
  private pose = new Float64Array(JOINTS * 2);
  private stars: { x: number; y: number; r: number; a: number }[] = [];
  private w = 0;
  private h = 0;
  /** The world's look; swap it when the level's planet changes. */
  theme: Theme = THEMES.earth!;
  /** Camera shake strength, 0 to switch it off. */
  shakeScale = 1;
  /** Extra lines under the clock (race position and the like). */
  hudLines: string[] = [];
  /** Hide the clock and hints, for when a menu covers the game. */
  hudHidden = false;
  /** Where across the screen the bike sits, 0..1 (off-center when a menu covers the middle). */
  focusX = 0.5;
  levelLabel = "";
  /** Shown in the middle of the screen while a level is being built. */
  busyText = "";
  /** Shown under "Press ↑ to go" and under the crash message. */
  startHint = "";
  crashHint = "";
  /** Key reminders, bottom right. */
  keysLabel = "";
  /** Played by touch: before a run starts, show which part of the screen does what. */
  touch = false;
  private zonesAlpha = 0;
  /** Screen edges to keep clear of, in pixels (a phone's notch and home bar). */
  safe = { l: 0, r: 0, b: 0 };

  constructor(
    private canvas: HTMLCanvasElement,
    private fx: Effects,
  ) {
    this.ctx = canvas.getContext("2d")!;
    for (let i = 0; i < 90; i++) {
      this.stars.push({ x: Math.random(), y: Math.random() * 0.5, r: 0.5 + Math.random() * 1.1, a: 0.25 + Math.random() * 0.6 });
    }
    this.resize();
    window.addEventListener("resize", () => this.resize());
  }

  private resize(): void {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    this.w = window.innerWidth;
    this.h = window.innerHeight;
    this.canvas.width = Math.round(this.w * dpr);
    this.canvas.height = Math.round(this.h * dpr);
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  resetCamera(): void {
    this.camInit = false;
  }

  draw(game: Game, alpha: number, dt: number): void {
    const ctx = this.ctx;
    const v = this.view;
    const cur = game.state;
    const track = game.track;
    const cfg = game.simCfg;
    fillView(v, game.prev, cur, alpha);

    // Camera: look ahead in the direction of travel, pull back a little at speed.
    const tx = v.x + Math.max(-4, Math.min(4, cur.vx * 0.16)) + 2;
    const ty = v.y + cur.vy * 0.08 + 1.2;
    const zk = 1 - 0.2 * Math.min(1, Math.hypot(cur.vx, cur.vy) / 30);
    if (!this.camInit) {
      this.camX = tx;
      this.camY = ty;
      this.zoomK = zk;
      this.camInit = true;
    } else {
      const k = 1 - Math.exp(-dt * 6);
      this.camX += (tx - this.camX) * k;
      this.camY += (ty - this.camY) * k;
      this.zoomK += (zk - this.zoomK) * (1 - Math.exp(-dt * 1.5));
    }
    const zoom = Math.min(this.w / 19, this.h / 9.5) * this.zoomK;
    const shake = this.fx.shake * this.shakeScale;
    const camX = this.camX + (Math.random() - 0.5) * shake;
    const camY = this.camY + (Math.random() - 0.5) * shake;

    this.drawSky();
    const T = this.theme;
    this.drawHills(0.05, 0.47, T.hillFar, 0.8, 0);
    this.drawHills(0.11, 0.55, T.hillMid, 1.2, 2.1);
    this.drawHills(0.2, 0.64, T.hillNear, 1.8, 4.4);

    ctx.save();
    ctx.translate(this.w * this.focusX, this.h * 0.58);
    ctx.scale(zoom, -zoom);
    ctx.translate(-camX, -camY);
    const leftW = (this.w * this.focusX) / zoom + 1;
    const rightW = (this.w * (1 - this.focusX)) / zoom + 1;
    const bottom = camY - (this.h * 0.42) / zoom - 1;
    this.drawTrack(track, camX - leftW, camX + rightW, bottom, camY);
    this.fx.drawBack(ctx);

    if (game.ghost && game.ghostPrev && game.best && game.started) {
      fillView(this.ghostView, game.ghostPrev, game.ghost, alpha);
      ctx.globalAlpha = 0.28;
      this.drawBike(this.ghostView, game.best.cfg, true);
      ctx.globalAlpha = 1;
    }
    // the rest of a watched pack: half-transparent, the main rider drawn solid on top
    for (const p of game.pack) {
      if (p.state.x < camX - leftW - 3 || p.state.x > camX + rightW + 3) continue;
      fillView(this.ghostView, p.prev, p.state, alpha);
      ctx.globalAlpha = p.state.status === CRASHED ? 0.25 : 0.5;
      this.drawBike(this.ghostView, p.replay.cfg, true);
    }
    ctx.globalAlpha = 1;
    this.drawShadow(track, v, cfg);
    this.drawBike(v, cfg, game.ragdoll === null);
    if (game.ragdoll) this.drawRagdoll(game.ragdoll, alpha, cfg);
    this.fx.drawFront(ctx);
    ctx.restore();

    this.drawVignette();
    // the touch zones show while a run waits for its first touch, and are gone once it is under way
    const waiting = this.touch && !this.hudHidden && !this.busyText && game.mode === "play" && !game.started;
    this.zonesAlpha = waiting ? Math.min(1, this.zonesAlpha + dt * 5) : Math.max(0, this.zonesAlpha - dt * 9);
    if (this.zonesAlpha > 0) this.drawZones(this.zonesAlpha);
    this.drawHud(game);
  }

  private drawSky(): void {
    const ctx = this.ctx;
    const T = this.theme;
    const g = ctx.createLinearGradient(0, 0, 0, this.h * 0.75);
    g.addColorStop(0, T.skyTop);
    g.addColorStop(0.55, T.skyMid);
    g.addColorStop(1, T.skyBottom);
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, this.w, this.h);

    ctx.fillStyle = "#fff";
    for (const s of this.stars) {
      const fade = T.airless ? 1 : 1 - s.y * 1.8;
      ctx.globalAlpha = Math.max(0, Math.min(1, s.a * fade * T.stars));
      ctx.beginPath();
      ctx.arc(s.x * this.w, s.y * this.h * (T.airless ? 1.3 : 1), s.r, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.globalAlpha = 1;

    // the sun and its glow
    const sun = T.sun;
    const sx = this.w * sun.x;
    const sy = this.h * sun.y - this.camY * 0.3;
    const glow = ctx.createRadialGradient(sx, sy, 0, sx, sy, this.h * sun.glowSize);
    glow.addColorStop(0, `rgba(${sun.glow},0.75)`);
    glow.addColorStop(0.2, `rgba(${sun.glow},0.32)`);
    glow.addColorStop(1, `rgba(${sun.glow},0)`);
    ctx.fillStyle = glow;
    ctx.fillRect(0, 0, this.w, this.h);
    ctx.fillStyle = sun.color;
    ctx.beginPath();
    ctx.arc(sx, sy, this.h * sun.r, 0, Math.PI * 2);
    ctx.fill();

    const body = T.body;
    if (!body) return;
    const bx = this.w * body.x;
    const by = this.h * body.y - this.camY * 0.15;
    const br = this.h * body.r;
    ctx.save();
    ctx.beginPath();
    ctx.arc(bx, by, br, 0, Math.PI * 2);
    if (body.kind === "earth") {
      ctx.clip();
      ctx.fillStyle = "#2f6fc4";
      ctx.fillRect(bx - br, by - br, br * 2, br * 2);
      ctx.fillStyle = "#4f9a5a";
      for (const [dx, dy, r] of [[-0.35, -0.2, 0.42], [0.3, 0.35, 0.36], [0.45, -0.45, 0.22]] as const) {
        ctx.beginPath();
        ctx.ellipse(bx + dx * br, by + dy * br, r * br, r * br * 0.7, 0.5, 0, Math.PI * 2);
        ctx.fill();
      }
      ctx.fillStyle = "rgba(255,255,255,0.75)";
      for (const [dx, dy, r] of [[-0.1, 0.5, 0.4], [0.2, -0.15, 0.3], [-0.5, -0.55, 0.3]] as const) {
        ctx.beginPath();
        ctx.ellipse(bx + dx * br, by + dy * br, r * br, r * br * 0.25, -0.3, 0, Math.PI * 2);
        ctx.fill();
      }
      // night side
      ctx.fillStyle = "rgba(0,0,8,0.82)";
      ctx.beginPath();
      ctx.arc(bx - br * 0.55, by + br * 0.25, br * 1.15, 0, Math.PI * 2);
      ctx.fill();
    } else if (body.kind === "moonlet") {
      ctx.fillStyle = "#e8d6c0";
      ctx.fill();
      ctx.beginPath();
      ctx.arc(bx + this.w * 0.12, by + this.h * 0.07, br * 0.6, 0, Math.PI * 2);
      ctx.fill();
    } else {
      ctx.fillStyle = "#7fae6a";
      ctx.fill();
      ctx.clip();
      ctx.fillStyle = "rgba(0,10,5,0.6)";
      ctx.beginPath();
      ctx.arc(bx - br * 0.5, by - br * 0.2, br * 1.1, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();
      ctx.save();
      ctx.strokeStyle = "rgba(190,230,160,0.55)";
      ctx.lineWidth = Math.max(1.5, br * 0.12);
      ctx.beginPath();
      ctx.ellipse(bx, by, br * 1.9, br * 0.45, -0.35, 0, Math.PI * 2);
      ctx.stroke();
    }
    ctx.restore();
  }

  private drawHills(parallax: number, base: number, color: string, freq: number, phase: number): void {
    const ctx = this.ctx;
    const off = this.camX * parallax * 40;
    const y0 = this.h * base - this.camY * parallax * 6;
    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.moveTo(0, this.h);
    for (let px = 0; px <= this.w + 12; px += 12) {
      const u = ((px + off) / 300) * freq + phase;
      const y = y0 - (Math.sin(u) * 38 + Math.sin(u * 2.3 + 1.7) * 18 + Math.sin(u * 0.41 + 4) * 55 + Math.sin(u * 5.1) * 5) * this.theme.hillScale;
      ctx.lineTo(px, y);
    }
    ctx.lineTo(this.w, this.h);
    ctx.fill();
  }

  private drawTrack(track: Track, left: number, right: number, bottom: number, camY: number): void {
    const ctx = this.ctx;
    const T = this.theme;
    const xs = track.xs;
    const ys = track.ys;
    const a = Math.max(0, segmentIndex(track, left - DEPTH_X) - 1);
    const b = Math.min(track.n - 1, segmentIndex(track, right + DEPTH_X) + 2);
    const fx = -DEPTH_X / 2; // front edge offset
    const fy = -DEPTH_Y / 2;
    const path = (ox: number, oy: number) => {
      for (let i = a; i <= b; i++) ctx.lineTo(xs[i]! + ox, ys[i]! + oy);
    };

    // top surface strip (back edge to front edge), lit from the far side
    ctx.beginPath();
    path(-fx, -fy);
    for (let i = b; i >= a; i--) ctx.lineTo(xs[i]! + fx, ys[i]! + fy);
    ctx.closePath();
    ctx.fillStyle = T.strip;
    ctx.fill();
    ctx.beginPath();
    path(-fx, -fy);
    ctx.strokeStyle = T.stripFar;
    ctx.lineWidth = 0.04;
    ctx.lineJoin = "round";
    ctx.stroke();

    // front face
    ctx.beginPath();
    ctx.moveTo(xs[a]! + fx, bottom);
    path(fx, fy);
    ctx.lineTo(xs[b]! + fx, bottom);
    ctx.closePath();
    const g = ctx.createLinearGradient(0, camY + 2, 0, camY - 7);
    g.addColorStop(0, T.groundTop);
    g.addColorStop(1, T.groundBottom);
    ctx.fillStyle = g;
    ctx.fill();

    // rock strata: faint lines that follow the surface, fading with depth
    ctx.save();
    ctx.clip();
    const layers = [0.35, 0.85, 1.6, 2.6];
    for (let k = 0; k < layers.length; k++) {
      ctx.beginPath();
      path(fx + layers[k]! * 0.25, fy - layers[k]!);
      ctx.strokeStyle = k % 2 === 0 ? "rgba(255,235,245,0.07)" : "rgba(0,0,0,0.22)";
      ctx.lineWidth = 0.05 + k * 0.035;
      ctx.stroke();
    }
    ctx.restore();

    // front edge highlight
    ctx.beginPath();
    path(fx, fy);
    ctx.strokeStyle = T.stripEdge;
    ctx.lineWidth = 0.05;
    ctx.stroke();

    this.drawStartFlag(track, track.startX - 1.5);
    this.drawFinishFlag(track, track.finishX);
  }

  private drawStartFlag(track: Track, x: number): void {
    const ctx = this.ctx;
    const T = this.theme;
    const y = heightAt(track, x) + DEPTH_Y / 2;
    ctx.strokeStyle = T.stripEdge;
    ctx.lineWidth = 0.06;
    ctx.beginPath();
    ctx.moveTo(x, y);
    ctx.lineTo(x, y + 2.6);
    ctx.stroke();
    ctx.fillStyle = "#7bd389";
    ctx.beginPath();
    ctx.moveTo(x, y + 2.6);
    ctx.lineTo(x + 0.9, y + 2.3);
    ctx.lineTo(x, y + 2.0);
    ctx.fill();
  }

  private drawFinishFlag(track: Track, x: number): void {
    const ctx = this.ctx;
    const T = this.theme;
    const y = heightAt(track, x) + DEPTH_Y / 2;
    ctx.strokeStyle = T.stripEdge;
    ctx.lineWidth = 0.07;
    ctx.beginPath();
    ctx.moveTo(x, y);
    ctx.lineTo(x, y + 3.4);
    ctx.stroke();
    const cols = 5;
    const rows = 4;
    const cw = 0.26;
    for (let i = 0; i < cols; i++) {
      for (let j = 0; j < rows; j++) {
        ctx.fillStyle = (i + j) % 2 === 0 ? "#f2e9e4" : "#15131f";
        ctx.fillRect(x + i * cw, y + 3.4 - (j + 1) * cw, cw + 0.005, cw + 0.005);
      }
    }
  }

  /** Soft contact shadows on the track under the wheels and frame; fade as the bike leaves the ground. */
  private drawShadow(track: Track, v: View, cfg: BikeConfig): void {
    const ctx = this.ctx;
    const blob = (x: number, y: number, half: number) => {
      const gy = heightAt(track, x);
      const h = Math.max(0, y - gy);
      const a = 0.3 * Math.max(0, 1 - h / 3.5);
      if (a <= 0.01) return;
      const slope = Math.atan2(heightAt(track, x + 0.2) - heightAt(track, x - 0.2), 0.4);
      ctx.globalAlpha = a;
      ctx.beginPath();
      ctx.ellipse(x, gy, half * (1 + h * 0.15), 0.1, slope, 0, Math.PI * 2);
      ctx.fill();
    };
    ctx.fillStyle = "#0a0912";
    blob(v.rear.x, v.rear.y - cfg.wheelRadius, 0.36);
    blob(v.front.x, v.front.y - cfg.wheelRadius, 0.36);
    blob(v.x, v.y - 0.6, 0.6);
    ctx.globalAlpha = 1;
  }

  private drawWheel(wh: View["rear"], radius: number): void {
    const ctx = this.ctx;
    const r = Math.max(0.2, radius); // the drawing needs room for tire, rim and hub
    ctx.save();
    ctx.translate(wh.x, wh.y);
    ctx.rotate(wh.angle);
    // tire with knobs
    ctx.beginPath();
    ctx.arc(0, 0, r - 0.05, 0, Math.PI * 2);
    ctx.strokeStyle = C.tire;
    ctx.lineWidth = 0.1;
    ctx.stroke();
    ctx.setLineDash([0.05, 0.062]);
    ctx.beginPath();
    ctx.arc(0, 0, r - 0.012, 0, Math.PI * 2);
    ctx.lineWidth = 0.03;
    ctx.stroke();
    ctx.setLineDash([]);
    // rim and spokes
    ctx.beginPath();
    ctx.arc(0, 0, r - 0.12, 0, Math.PI * 2);
    ctx.strokeStyle = C.rim;
    ctx.lineWidth = 0.028;
    ctx.stroke();
    ctx.beginPath();
    for (let i = 0; i < 8; i++) {
      const a = (i / 8) * Math.PI * 2;
      ctx.moveTo(Math.cos(a + 0.5) * 0.05, Math.sin(a + 0.5) * 0.05);
      ctx.lineTo(Math.cos(a) * (r - 0.12), Math.sin(a) * (r - 0.12));
    }
    ctx.lineWidth = 0.012;
    ctx.stroke();
    // brake disc and hub
    ctx.beginPath();
    ctx.arc(0, 0, 0.11, 0, Math.PI * 2);
    ctx.strokeStyle = "#6c7180";
    ctx.lineWidth = 0.025;
    ctx.stroke();
    ctx.beginPath();
    ctx.arc(0, 0, 0.05, 0, Math.PI * 2);
    ctx.fillStyle = C.metal;
    ctx.fill();
    ctx.restore();
  }

  private stroke(pts: number[], color: string, width: number): void {
    const ctx = this.ctx;
    ctx.beginPath();
    for (let i = 0; i < pts.length; i += 2) ctx.lineTo(pts[i]!, pts[i + 1]!);
    ctx.strokeStyle = color;
    ctx.lineWidth = width;
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    ctx.stroke();
  }

  private poly(pts: number[], color: string): void {
    const ctx = this.ctx;
    ctx.beginPath();
    for (let i = 0; i < pts.length; i += 2) ctx.lineTo(pts[i]!, pts[i + 1]!);
    ctx.closePath();
    ctx.fillStyle = color;
    ctx.fill();
  }

  private drawBike(v: View, cfg: BikeConfig, withRider: boolean): void {
    const ctx = this.ctx;
    const c = v.rx;
    const s = v.ry;
    const X = (lx: number, ly: number) => v.x + c * lx - s * ly;
    const Y = (lx: number, ly: number) => v.y + s * lx + c * ly;

    // swingarm, shock and fork reach to the actual wheel positions, so suspension travel is visible
    this.stroke([X(-0.1, -0.2), Y(-0.1, -0.2), v.rear.x, v.rear.y], C.metal, 0.075);
    this.stroke([X(-0.22, 0.12), Y(-0.22, 0.12), lerp(X(-0.1, -0.2), v.rear.x, 0.45), lerp(Y(-0.1, -0.2), v.rear.y, 0.45)], "#e8b23a", 0.05);
    this.stroke([X(0.46, 0.36), Y(0.46, 0.36), v.front.x, v.front.y], C.metal, 0.065);
    this.stroke([X(0.46, 0.36), Y(0.46, 0.36), lerp(X(0.46, 0.36), v.front.x, 0.5), lerp(Y(0.46, 0.36), v.front.y, 0.5)], "#d7dae2", 0.085);

    this.drawWheel(v.rear, cfg.wheelRadius);
    this.drawWheel(v.front, cfg.wheelRadius);

    const p = riderPose(cfg, v.lean, this.pose);
    const jx = (j: number, ox = 0) => p[j * 2]! + ox;
    const jy = (j: number, oy = 0) => p[j * 2 + 1]! + oy;

    // from here on, draw in the chassis frame
    ctx.save();
    ctx.translate(v.x, v.y);
    ctx.rotate(Math.atan2(s, c));

    if (withRider) {
      // far-side arm and leg, darker, slightly offset
      this.stroke([jx(J_HIP), jy(J_HIP), jx(J_KNEE, 0.04), jy(J_KNEE, 0.03), jx(J_FOOT, 0.05), jy(J_FOOT)], C.pantsFar, 0.13);
      this.stroke([jx(J_SHOULDER), jy(J_SHOULDER), jx(J_ELBOW, 0.04), jy(J_ELBOW, 0.03), jx(J_HAND), jy(J_HAND)], C.jerseyFar, 0.085);
    }

    // exhaust
    this.stroke([0.12, -0.2, -0.22, -0.14, -0.4, 0.0], C.metal, 0.05);
    this.stroke([-0.4, 0.0, -0.68, 0.1], "#c7cbd6", 0.085);
    // frame tubes
    this.stroke([-0.14, -0.24, 0.3, -0.26, 0.44, 0.3], "#565b6b", 0.05);
    this.stroke([-0.14, -0.24, -0.2, 0.12, -0.62, 0.2], "#565b6b", 0.045);
    // engine
    this.poly([-0.12, -0.27, 0.24, -0.27, 0.3, -0.02, 0.1, 0.06, -0.12, 0.02], C.engine);
    this.stroke([0.02, -0.18, 0.2, -0.18], "#4a4e5e", 0.03);
    this.stroke([0.04, -0.1, 0.22, -0.1], "#4a4e5e", 0.03);
    ctx.beginPath();
    ctx.arc(-0.02, -0.17, 0.07, 0, Math.PI * 2);
    ctx.fillStyle = "#4a4e5e";
    ctx.fill();
    // rear fender and side panel
    if (v.fender) this.poly([-0.86, 0.3, -0.3, 0.2, -0.24, 0.06, -0.5, 0.1, -0.84, 0.25], C.frame);
    else this.poly([-0.5, 0.24, -0.3, 0.2, -0.24, 0.06, -0.5, 0.1, -0.56, 0.17], C.frame); // snapped stub
    this.poly([-0.56, 0.18, -0.26, 0.17, -0.24, 0.06, -0.46, 0.09], C.frameDark);
    // seat
    this.stroke([-0.6, 0.25, -0.2, 0.21, 0.04, 0.22], C.seat, 0.07);
    // tank and shroud
    this.poly([0.0, 0.2, 0.2, 0.31, 0.4, 0.27, 0.46, 0.08, 0.3, -0.04, 0.06, 0.03], C.frame);
    this.poly([0.22, 0.18, 0.44, 0.14, 0.46, 0.08, 0.3, -0.04, 0.2, 0.02], C.frameDark);
    this.stroke([0.08, 0.14, 0.34, 0.2], "#ffd9d0", 0.02);
    // front fender, number plate, bars
    this.stroke([0.44, 0.2, 0.74, 0.19, 0.98, 0.08], C.frame, 0.05);
    this.poly([0.47, 0.22, 0.58, 0.24, 0.56, 0.42, 0.45, 0.4], "#f2e9e4");
    this.stroke([0.4, 0.36, 0.47, 0.43], C.seat, 0.045);
    // foot peg
    this.stroke([-0.08, -0.22, 0.04, -0.22], C.metal, 0.035);

    if (withRider) {
      // near leg with boot
      this.stroke([jx(J_HIP), jy(J_HIP), jx(J_KNEE), jy(J_KNEE), jx(J_FOOT), jy(J_FOOT)], C.pants, 0.14);
      this.stroke([lerp(jx(J_KNEE), jx(J_FOOT), 0.55), lerp(jy(J_KNEE), jy(J_FOOT), 0.55), jx(J_FOOT), jy(J_FOOT), jx(J_FOOT, 0.12), jy(J_FOOT, -0.01)], C.boot, 0.11);
      // torso
      this.stroke([jx(J_HIP), jy(J_HIP), jx(J_SHOULDER), jy(J_SHOULDER)], C.jersey, 0.2);
      this.stroke([jx(J_HIP, 0.02), jy(J_HIP, 0.04), jx(J_SHOULDER, 0.02), jy(J_SHOULDER, -0.03)], "#f2e9e4", 0.03);
      // near arm with glove
      this.stroke([jx(J_SHOULDER), jy(J_SHOULDER), jx(J_ELBOW), jy(J_ELBOW), jx(J_HAND), jy(J_HAND)], C.jersey, 0.095);
      this.stroke([lerp(jx(J_ELBOW), jx(J_HAND), 0.8), lerp(jy(J_ELBOW), jy(J_HAND), 0.8), jx(J_HAND), jy(J_HAND)], C.boot, 0.095);
      this.drawHelmet(jx(J_HEAD), jy(J_HEAD), cfg.headRadius);
    }
    ctx.restore();
  }

  /** Helmet centered on the origin point given, facing +x in the current transform. */
  private drawHelmet(x: number, y: number, r: number): void {
    const ctx = this.ctx;
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.fillStyle = C.helmet;
    ctx.fill();
    // chin bar and peak
    this.stroke([x + r * 0.55, y - r * 0.55, x + r * 1.15, y - r * 0.5], C.helmet, r * 0.55);
    this.stroke([x + r * 0.3, y + r * 0.75, x + r * 1.35, y + r * 0.6], C.frame, r * 0.3);
    // visor and stripe
    this.stroke([x + r * 0.35, y + r * 0.12, x + r * 0.95, y + r * 0.05], C.visor, r * 0.55);
    this.stroke([x - r * 0.75, y + r * 0.45, x - r * 0.1, y + r * 0.85], C.frame, r * 0.22);
  }

  private drawRagdoll(r: RD.Ragdoll, alpha: number, cfg: BikeConfig): void {
    const ctx = this.ctx;
    const px = (i: number) => lerp(r.px[i]!, r.x[i]!, alpha);
    const py = (i: number) => lerp(r.py[i]!, r.y[i]!, alpha);
    const limb = (ids: number[], color: string, width: number) => {
      const pts: number[] = [];
      for (const i of ids) pts.push(px(i), py(i));
      this.stroke(pts, color, width);
    };
    limb([RD.R_HIP, RD.R_KNEE_B, RD.R_FOOT_B], C.pantsFar, 0.13);
    limb([RD.R_SHOULDER, RD.R_ELBOW_B, RD.R_HAND_B], C.jerseyFar, 0.085);
    limb([RD.R_HIP, RD.R_SHOULDER], C.jersey, 0.2);
    limb([RD.R_HIP, RD.R_KNEE_A, RD.R_FOOT_A], C.pants, 0.14);
    limb([RD.R_SHOULDER, RD.R_ELBOW_A, RD.R_HAND_A], C.jersey, 0.095);
    // helmet turned to follow the neck
    const hx = px(RD.R_HEAD);
    const hy = py(RD.R_HEAD);
    ctx.save();
    ctx.translate(hx, hy);
    ctx.rotate(Math.atan2(hy - py(RD.R_SHOULDER), hx - px(RD.R_SHOULDER)) - Math.PI / 2);
    this.drawHelmet(0, 0, cfg.headRadius);
    ctx.restore();
  }

  private drawVignette(): void {
    const ctx = this.ctx;
    const r = Math.hypot(this.w, this.h) / 2;
    const g = ctx.createRadialGradient(this.w / 2, this.h / 2, r * 0.55, this.w / 2, this.h / 2, r);
    g.addColorStop(0, "rgba(0,0,0,0)");
    g.addColorStop(1, "rgba(0,0,0,0.35)");
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, this.w, this.h);
    const f = this.fx.flash;
    if (f > 0) {
      const red = ctx.createRadialGradient(this.w / 2, this.h / 2, r * 0.25, this.w / 2, this.h / 2, r);
      red.addColorStop(0, `rgba(160,10,20,${0.12 * f})`);
      red.addColorStop(1, `rgba(160,10,20,${0.7 * f})`);
      ctx.fillStyle = red;
      ctx.fillRect(0, 0, this.w, this.h);
    }
  }

  /** The four touch zones, laid out as the fingers find them: lean on top, brake and throttle below. */
  private drawZones(a: number): void {
    const ctx = this.ctx;
    const { l, r, b } = this.safe;
    const m = 8;
    const x0 = l + m;
    const x1 = this.w - r - m;
    const y1 = this.h - b - m;
    const cx = this.w / 2;
    const cy = this.h / 2;
    const pulse = 0.5 + 0.5 * Math.sin(performance.now() / 260);
    const zones = [
      { x: x0, y: m, w: cx - m / 2 - x0, h: cy - m * 1.5, label: "LEAN BACK", sub: "", color: "242,233,228", glow: 0, icon: "back" },
      { x: cx + m / 2, y: m, w: x1 - cx - m / 2, h: cy - m * 1.5, label: "LEAN FORWARD", sub: "", color: "242,233,228", glow: 0, icon: "fwd" },
      { x: x0, y: cy + m / 2, w: cx - m / 2 - x0, h: y1 - cy - m / 2, label: "BRAKE", sub: "", color: "255,128,128", glow: 0.04, icon: "brake" },
      { x: cx + m / 2, y: cy + m / 2, w: x1 - cx - m / 2, h: y1 - cy - m / 2, label: "GAS", sub: "hold to go", color: "255,209,102", glow: 0.07 + 0.1 * pulse, icon: "gas" },
    ];
    ctx.save();
    ctx.globalAlpha = a;
    ctx.lineJoin = "round";
    ctx.lineCap = "round";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    for (const z of zones) {
      ctx.beginPath();
      ctx.roundRect(z.x, z.y, z.w, z.h, 16);
      ctx.fillStyle = `rgba(${z.color},${0.06 + z.glow})`;
      ctx.fill();
      ctx.lineWidth = z.icon === "gas" ? 2 : 1.5;
      ctx.strokeStyle = `rgba(${z.color},${z.icon === "gas" ? 0.55 + 0.4 * pulse : 0.38})`;
      ctx.stroke();

      const mx = z.x + z.w / 2;
      const my = z.y + z.h / 2 + (z.sub ? -8 : 0);
      ctx.fillStyle = ctx.strokeStyle = `rgba(${z.color},0.95)`;
      ctx.lineWidth = 3;
      const iy = my - 26;
      ctx.beginPath();
      if (z.icon === "gas") {
        ctx.moveTo(mx - 9, iy - 12);
        ctx.lineTo(mx + 12, iy);
        ctx.lineTo(mx - 9, iy + 12);
        ctx.closePath();
        ctx.fill();
      } else if (z.icon === "brake") {
        ctx.roundRect(mx - 10, iy - 10, 20, 20, 3);
        ctx.fill();
      } else {
        // a turning arrow: the way the bike tips
        const dir = z.icon === "fwd" ? 1 : -1;
        const from = -Math.PI / 2 - dir * 2.2;
        const to = -Math.PI / 2 + dir * 0.9;
        ctx.arc(mx, iy, 11, from, to, dir < 0);
        ctx.stroke();
        const ex = mx + 11 * Math.cos(to);
        const ey = iy + 11 * Math.sin(to);
        const heading = to + (dir * Math.PI) / 2;
        ctx.beginPath();
        ctx.moveTo(ex + 7 * Math.cos(heading), ey + 7 * Math.sin(heading));
        ctx.lineTo(ex + 6 * Math.cos(heading + 2.2), ey + 6 * Math.sin(heading + 2.2));
        ctx.lineTo(ex + 6 * Math.cos(heading - 2.2), ey + 6 * Math.sin(heading - 2.2));
        ctx.closePath();
        ctx.fill();
      }
      ctx.font = "800 17px system-ui, sans-serif";
      ctx.fillStyle = "rgba(0,0,0,0.45)";
      ctx.fillText(z.label, mx + 1, my + 9);
      ctx.fillStyle = `rgba(${z.color},1)`;
      ctx.fillText(z.label, mx, my + 8);
      if (z.sub) {
        ctx.font = "500 13px ui-monospace, Menlo, monospace";
        ctx.fillStyle = "rgba(0,0,0,0.45)";
        ctx.fillText(z.sub, mx + 1, my + 31);
        ctx.fillStyle = `rgba(${z.color},1)`;
        ctx.fillText(z.sub, mx, my + 30);
      }
    }
    ctx.restore();
  }

  private drawHud(game: Game): void {
    if (this.hudHidden) return;
    const ctx = this.ctx;
    const left = 20 + this.safe.l;
    const low = this.h - 16 - this.safe.b;
    const s = game.state;
    const cfg = game.simCfg;
    const time = formatTime(s.status === 0 ? s.tick : s.endTick);

    ctx.fillStyle = C.text;
    ctx.textBaseline = "top";
    ctx.font = "600 28px ui-monospace, Menlo, monospace";
    ctx.textAlign = "left";
    ctx.fillText(time, left, 16);
    ctx.font = "500 15px ui-monospace, Menlo, monospace";
    ctx.fillText(`${Math.round(Math.hypot(s.vx, s.vy) * 3.6)} km/h`, left, 52);
    let y = 74;
    if (game.best) {
      ctx.globalAlpha = 0.7;
      ctx.fillText(`best ${formatTime(game.best.ticks)}`, left, y);
      ctx.globalAlpha = 1;
      y += 22;
    }
    ctx.fillStyle = "#ffd166";
    if (game.mode === "replay") {
      ctx.fillText(game.watchLabel, left, y);
      y += 22;
    }
    for (const line of this.hudLines) {
      ctx.fillText(line, left, y);
      y += 22;
    }
    if (s.headDamage > 0 && s.status === 0) {
      const f = Math.min(1, s.headDamage / cfg.headDamageMax);
      ctx.fillStyle = "rgba(0,0,0,0.35)";
      ctx.fillRect(left, y + 6, 120, 8);
      ctx.fillStyle = "#ef4b4b";
      ctx.fillRect(left, y + 6, 120 * f, 8);
    }

    ctx.globalAlpha = 0.55;
    ctx.fillStyle = C.text;
    ctx.font = "500 12px ui-monospace, Menlo, monospace";
    ctx.textBaseline = "bottom";
    ctx.fillText(this.levelLabel, left, low);
    ctx.textAlign = "right";
    ctx.fillText(this.keysLabel, this.w - 20 - this.safe.r, low);
    ctx.textAlign = "left";
    ctx.textBaseline = "top";
    ctx.globalAlpha = 1;

    let msg = "";
    let sub = "";
    if (this.busyText) {
      msg = "Building level";
      sub = this.busyText;
    } else if (game.mode === "replay") {
      // a replay speaks for itself
    } else if (!game.started) {
      // by touch the zones say how to set off
      msg = this.touch ? "" : "Press ↑ to go";
      sub = this.startHint;
    } else if (s.status === CRASHED) {
      msg = s.crashCause === CAUSE_NECK ? "Broken neck" : s.crashCause === CAUSE_CRUSHED ? "Crushed" : "Head impact";
      sub = this.crashHint;
    }
    if (msg || sub) {
      ctx.textAlign = "center";
      // big words shrink to fit a phone
      ctx.font = `700 ${Math.round(Math.min(40, this.w / 16))}px system-ui, sans-serif`;
      ctx.fillStyle = "rgba(0,0,0,0.4)";
      ctx.fillText(msg, this.w / 2 + 2, this.h * 0.2 + 2);
      ctx.fillStyle = C.text;
      ctx.fillText(msg, this.w / 2, this.h * 0.2);
      if (sub) {
        ctx.font = "500 15px ui-monospace, Menlo, monospace";
        ctx.fillText(sub, this.w / 2, this.h * 0.2 + 56);
      }
    }
  }
}
