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
  onRestart: () => void = () => {};
  /** Other single-press keys, by KeyboardEvent.code (e.g. "KeyP"). */
  onKey: (code: string) => void = () => {};

  constructor(target: Window) {
    target.addEventListener("keydown", (e) => {
      if (e.target instanceof HTMLInputElement) return;
      const bit = KEYS[e.code];
      if (bit !== undefined) {
        this.mask |= bit;
        e.preventDefault();
      } else if ((e.code === "KeyR" || e.code === "Enter" || e.code === "Space") && !e.repeat) {
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
