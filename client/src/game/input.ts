// Keyboard + mouse controls, with an on-screen joystick for touch devices.
import type { PlayerInput } from '../../../shared/sim';

export class InputManager {
  private keys = new Set<string>();
  private mouse = { x: 0, y: 0, left: false, right: false };
  private dashPressed = false;
  private lastAim = 0;
  touch = { active: false, jx: 0, jy: 0, attract: false, repel: false };
  private cleanup: (() => void)[] = [];
  onSpectateNext?: () => void;

  constructor(private canvas: HTMLCanvasElement) {
    const on = <K extends keyof WindowEventMap>(t: EventTarget, ev: K, fn: (e: WindowEventMap[K]) => void, opts?: AddEventListenerOptions) => {
      t.addEventListener(ev, fn as EventListener, opts);
      this.cleanup.push(() => t.removeEventListener(ev, fn as EventListener, opts));
    };
    on(window, 'keydown', (e) => {
      if ((e.target as HTMLElement)?.tagName === 'INPUT') return;
      const k = e.key.toLowerCase();
      if (k === ' ' || k.startsWith('arrow')) e.preventDefault();
      if (k === ' ' && !e.repeat) this.dashPressed = true;
      if ((k === 'tab') ) { e.preventDefault(); this.onSpectateNext?.(); }
      this.keys.add(k);
    });
    on(window, 'keyup', (e) => this.keys.delete(e.key.toLowerCase()));
    on(window, 'blur', () => { this.keys.clear(); this.mouse.left = this.mouse.right = false; });
    on(canvas, 'mousemove', (e) => { this.mouse.x = e.clientX; this.mouse.y = e.clientY; });
    on(canvas, 'mousedown', (e) => {
      if (e.button === 0) this.mouse.left = true;
      if (e.button === 2) this.mouse.right = true;
      if (e.button === 0) this.onSpectateNext?.();
    });
    on(window, 'mouseup', (e) => {
      if (e.button === 0) this.mouse.left = false;
      if (e.button === 2) this.mouse.right = false;
    });
    on(canvas, 'contextmenu', (e) => e.preventDefault());
  }

  private has(...k: string[]) {
    return k.some((x) => this.keys.has(x));
  }

  /** px/py = screen position of your planet (aim is relative to it). */
  read(px: number, py: number): PlayerInput {
    let mx = 0, my = 0;
    if (this.has('w', 'arrowup')) my -= 1;
    if (this.has('s', 'arrowdown')) my += 1;
    if (this.has('a', 'arrowleft')) mx -= 1;
    if (this.has('d', 'arrowright')) mx += 1;
    let aim = Math.atan2(this.mouse.y - py, this.mouse.x - px);
    if (this.touch.active) {
      mx = this.touch.jx;
      my = this.touch.jy;
      aim = Math.hypot(mx, my) > 0.2 ? Math.atan2(my, mx) : this.lastAim;
    }
    const l = Math.hypot(mx, my);
    if (l > 1) { mx /= l; my /= l; }
    this.lastAim = aim;
    const dash = this.dashPressed;
    this.dashPressed = false;
    return {
      mx, my, aim,
      attract: this.mouse.left || this.has('q', 'j') || this.touch.attract,
      repel: this.mouse.right || this.has('e', 'k') || this.has('shift') || this.touch.repel,
      dash,
    };
  }

  triggerDash() {
    this.dashPressed = true;
  }

  destroy() {
    this.cleanup.forEach((f) => f());
  }
}
