// Canvas renderer. Everything is drawn in code; there are no image files.
// Reads sim state only; nothing here feeds back into the simulation,
// so it is free to use trig, real time, and randomness.
import {
  CAUSE_CRUSHED,
  CAUSE_NECK,
  CRASHED,
  FINISHED,
  heightAt,
  segmentIndex,
  TICK_RATE,
  type BikeConfig,
  type SimState,
  type Track,
  type WheelState,
} from "../sim";
import type { Game } from "../game/game";
import * as RD from "../game/ragdoll";
import { J_ELBOW, J_FOOT, J_HAND, J_HEAD, J_HIP, J_KNEE, J_SHOULDER, JOINTS, riderPose } from "../game/rider";
import type { Effects } from "./effects";

const DEPTH_X = 0.28; // fake-3D: the track is a strip with this visual depth
const DEPTH_Y = 0.36;

const C = {
  skyTop: "#141a33",
  skyMid: "#4a3a6a",
  skyBottom: "#f0a878",
  hillFar: "#6f5a86",
  hillMid: "#463f68",
  hillNear: "#2b2947",
  groundTop: "#3a3452",
  groundBottom: "#13111c",
  strip: "#8f88ab",
  stripFar: "#6f6890",
  stripEdge: "#f2e9e4",
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

function formatTime(ticks: number): string {
  const t = ticks / TICK_RATE;
  const min = Math.floor(t / 60);
  return `${min}:${(t - min * 60).toFixed(2).padStart(5, "0")}`;
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
  soundOn = true;
  levelLabel = "";
  /** Shown in the middle of the screen while a level is being built. */
  busyText = "";
  hasSolution = false;

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
    const shake = this.fx.shake;
    const camX = this.camX + (Math.random() - 0.5) * shake;
    const camY = this.camY + (Math.random() - 0.5) * shake;

    this.drawSky();
    this.drawHills(0.05, 0.47, C.hillFar, 0.8, 0);
    this.drawHills(0.11, 0.55, C.hillMid, 1.2, 2.1);
    this.drawHills(0.2, 0.64, C.hillNear, 1.8, 4.4);

    ctx.save();
    ctx.translate(this.w / 2, this.h * 0.58);
    ctx.scale(zoom, -zoom);
    ctx.translate(-camX, -camY);
    const halfW = this.w / 2 / zoom + 1;
    const bottom = camY - (this.h * 0.42) / zoom - 1;
    this.drawTrack(track, camX - halfW, camX + halfW, bottom, camY);
    this.fx.drawBack(ctx);

    if (game.ghost && game.ghostPrev && game.best && game.started) {
      fillView(this.ghostView, game.ghostPrev, game.ghost, alpha);
      ctx.globalAlpha = 0.28;
      this.drawBike(this.ghostView, game.best.cfg, true);
      ctx.globalAlpha = 1;
    }
    this.drawShadow(track, v, cfg);
    this.drawBike(v, cfg, game.ragdoll === null);
    if (game.ragdoll) this.drawRagdoll(game.ragdoll, alpha, cfg);
    this.fx.drawFront(ctx);
    ctx.restore();

    this.drawVignette();
    this.drawHud(game);
  }

  private drawSky(): void {
    const ctx = this.ctx;
    const g = ctx.createLinearGradient(0, 0, 0, this.h * 0.75);
    g.addColorStop(0, C.skyTop);
    g.addColorStop(0.55, C.skyMid);
    g.addColorStop(1, C.skyBottom);
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, this.w, this.h);

    ctx.fillStyle = "#fff";
    for (const s of this.stars) {
      ctx.globalAlpha = s.a * (1 - s.y * 1.8);
      ctx.beginPath();
      ctx.arc(s.x * this.w, s.y * this.h, s.r, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.globalAlpha = 1;

    // low sun with a wide glow
    const sx = this.w * 0.7;
    const sy = this.h * 0.52 - this.camY * 0.3;
    const glow = ctx.createRadialGradient(sx, sy, 0, sx, sy, this.h * 0.5);
    glow.addColorStop(0, "rgba(255,225,180,0.75)");
    glow.addColorStop(0.2, "rgba(255,190,140,0.35)");
    glow.addColorStop(1, "rgba(255,170,120,0)");
    ctx.fillStyle = glow;
    ctx.fillRect(0, 0, this.w, this.h);
    ctx.fillStyle = "#ffe9c4";
    ctx.beginPath();
    ctx.arc(sx, sy, this.h * 0.045, 0, Math.PI * 2);
    ctx.fill();
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
      const y = y0 - (Math.sin(u) * 38 + Math.sin(u * 2.3 + 1.7) * 18 + Math.sin(u * 0.41 + 4) * 55 + Math.sin(u * 5.1) * 5);
      ctx.lineTo(px, y);
    }
    ctx.lineTo(this.w, this.h);
    ctx.fill();
  }

  private drawTrack(track: Track, left: number, right: number, bottom: number, camY: number): void {
    const ctx = this.ctx;
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
    ctx.fillStyle = C.strip;
    ctx.fill();
    ctx.beginPath();
    path(-fx, -fy);
    ctx.strokeStyle = C.stripFar;
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
    g.addColorStop(0, C.groundTop);
    g.addColorStop(1, C.groundBottom);
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
    ctx.strokeStyle = C.stripEdge;
    ctx.lineWidth = 0.05;
    ctx.stroke();

    this.drawStartFlag(track, track.startX - 1.5);
    this.drawFinishFlag(track, track.finishX);
  }

  private drawStartFlag(track: Track, x: number): void {
    const ctx = this.ctx;
    const y = heightAt(track, x) + DEPTH_Y / 2;
    ctx.strokeStyle = C.stripEdge;
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
    const y = heightAt(track, x) + DEPTH_Y / 2;
    ctx.strokeStyle = C.stripEdge;
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

  private drawHud(game: Game): void {
    const ctx = this.ctx;
    const s = game.state;
    const cfg = game.simCfg;
    const time = formatTime(s.status === 0 ? s.tick : s.endTick);

    ctx.fillStyle = C.text;
    ctx.textBaseline = "top";
    ctx.font = "600 28px ui-monospace, Menlo, monospace";
    ctx.textAlign = "left";
    ctx.fillText(time, 20, 16);
    ctx.font = "500 15px ui-monospace, Menlo, monospace";
    ctx.fillText(`${Math.round(Math.hypot(s.vx, s.vy) * 3.6)} km/h`, 20, 52);
    if (game.best) {
      ctx.globalAlpha = 0.7;
      ctx.fillText(`best ${formatTime(game.best.ticks)}`, 20, 74);
      ctx.globalAlpha = 1;
    }
    if (game.mode === "replay") {
      ctx.fillStyle = "#ffd166";
      ctx.fillText("REPLAY", 20, 96);
    }
    ctx.globalAlpha = 0.55;
    ctx.fillStyle = C.text;
    ctx.font = "500 12px ui-monospace, Menlo, monospace";
    ctx.textBaseline = "bottom";
    ctx.fillText(`${this.levelLabel}     N  next level     M  sound ${this.soundOn ? "on" : "off"}`, 20, this.h - 16);
    ctx.textBaseline = "top";
    ctx.globalAlpha = 1;
    ctx.font = "500 15px ui-monospace, Menlo, monospace";

    if (s.headDamage > 0 && s.status === 0) {
      const f = Math.min(1, s.headDamage / cfg.headDamageMax);
      ctx.fillStyle = "rgba(0,0,0,0.35)";
      ctx.fillRect(20, 120, 120, 8);
      ctx.fillStyle = "#ef4b4b";
      ctx.fillRect(20, 120, 120 * f, 8);
    }

    let msg = "";
    let sub = "";
    if (this.busyText) {
      msg = "Building level";
      sub = this.busyText;
    } else if (!game.started) {
      msg = "Press ↑ to go";
      sub = "↑ throttle   ↓ brake   ← lean back   → lean forward   R restart";
      if (game.best) sub += "   P watch best";
      if (this.hasSolution) sub += "   H watch a solution";
    } else if (s.status === CRASHED) {
      msg = s.crashCause === CAUSE_NECK ? "Broken neck" : s.crashCause === CAUSE_CRUSHED ? "Crushed" : "Head impact";
    } else if (s.status === FINISHED && game.mode === "play") {
      msg = `Finished  ${time}`;
      const r = game.result;
      if (r && r.previousBest !== null) {
        const d = (r.ticks - r.previousBest) / TICK_RATE;
        sub = r.newBest ? `New best!  ${d.toFixed(2)} s` : `+${d.toFixed(2)} s off your best`;
      } else if (r?.newBest) {
        sub = "First time on the board";
      }
      sub += (sub ? "   ·   " : "") + "R ride again   L watch this run   P watch best";
    }
    if (msg) {
      ctx.textAlign = "center";
      ctx.font = "700 40px system-ui, sans-serif";
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
