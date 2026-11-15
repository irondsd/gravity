import { IN_BRAKE, IN_LEAN_BACK, IN_LEAN_FWD, IN_THROTTLE } from "../sim";

const KEYS: Record<string, number> = {
  ArrowUp: IN_THROTTLE,
  KeyW: IN_THROTTLE,
  ArrowDown: IN_BRAKE,
  KeyS: IN_BRAKE,
  ArrowLeft: IN_LEAN_BACK,
  KeyA: IN_LEAN_BACK,
  ArrowRight: IN_LEAN_FWD,
  KeyD: IN_LEAN_FWD,
};

export class Keyboard {
  mask = 0;
  /** Off while a menu is open, so its keys are left alone. */
  enabled = true;
  onRestart: () => void = () => {};
  /** Other single-press keys, by KeyboardEvent.code (e.g. "KeyP"). */
  onKey: (code: string) => void = () => {};

  constructor(target: Window) {
    target.addEventListener("keydown", (e) => {
      if (!this.enabled || e.target instanceof HTMLInputElement) return;
      const bit = KEYS[e.code];
      if (bit !== undefined) {
        this.mask |= bit;
        e.preventDefault();
      } else if (e.code === "KeyR" && !e.repeat) {
        this.onRestart();
        e.preventDefault();
      } else if (!e.repeat && !e.metaKey && !e.ctrlKey) {
        this.onKey(e.code);
      }
    });
    target.addEventListener("keyup", (e) => {
      const bit = KEYS[e.code];
      if (bit !== undefined) this.mask &= ~bit;
    });
    target.addEventListener("blur", () => {
      this.mask = 0;
    });
  }
}

/** True while the game is being played by touch: on-screen buttons and touch wording are shown. */
export function isTouch(): boolean {
  return document.documentElement.classList.contains("touch");
}

/**
 * Touch controls: the screen is four zones, one per input, and every finger holds the zone it is on.
 * Bottom right is the throttle and bottom left the brake, where the thumbs rest; the top corners lean.
 */
export class TouchPad {
  mask = 0;
  /** Off while a menu is open. */
  enabled = true;
  /** A finger came down. Return true to use the tap up (restart after a crash, say) instead of riding with it. */
  onDown: () => boolean = () => false;
  private fingers = new Map<number, number>();

  constructor(private target: HTMLElement) {
    const zone = (e: PointerEvent): number => {
      const r = this.target.getBoundingClientRect();
      const right = e.clientX - r.left >= r.width / 2;
      if (e.clientY - r.top < r.height / 2) return right ? IN_LEAN_FWD : IN_LEAN_BACK;
      return right ? IN_THROTTLE : IN_BRAKE;
    };
    const lift = (e: PointerEvent) => {
      if (this.fingers.delete(e.pointerId)) this.sync();
    };
    target.addEventListener("pointerdown", (e) => {
      if (e.pointerType === "mouse" || !this.enabled) return;
      e.preventDefault();
      if (this.onDown()) return;
      this.fingers.set(e.pointerId, zone(e));
      this.sync();
    });
    target.addEventListener("pointermove", (e) => {
      // a finger may slide from one zone to the next without lifting
      if (!this.fingers.has(e.pointerId)) return;
      this.fingers.set(e.pointerId, zone(e));
      this.sync();
    });
    target.addEventListener("pointerup", lift);
    target.addEventListener("pointercancel", lift);
    // no scrolling, zooming, text selection or long-press menu on the game itself
    target.addEventListener("touchstart", (e) => e.preventDefault(), { passive: false });
    target.addEventListener("contextmenu", (e) => e.preventDefault());
    window.addEventListener("blur", () => this.reset());
  }

  /** Forget every finger; ones still down stay ignored until they are lifted. */
  reset(): void {
    this.fingers.clear();
    this.mask = 0;
  }

  private sync(): void {
    let mask = 0;
    for (const bit of this.fingers.values()) mask |= bit;
    this.mask = mask;
  }
}
