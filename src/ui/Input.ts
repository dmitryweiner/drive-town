import type { CarInput } from '../game/Car';

const TRACKED_KEYS = new Set<string>([
  'ArrowUp',
  'ArrowDown',
  'ArrowLeft',
  'ArrowRight',
  'KeyW',
  'KeyA',
  'KeyS',
  'KeyD',
  'Space',
]);

export class Input {
  private readonly pressed = new Set<string>();
  private touchSteer = 0;
  private touchThrottle = 0;
  private touchBrake = 0;
  retryRequested = false;
  nextRequested = false;

  constructor() {
    window.addEventListener('keydown', this.onKeyDown);
    window.addEventListener('keyup', this.onKeyUp);
    this.bindMobileControls();
    this.bindButtons();
  }

  destroy(): void {
    window.removeEventListener('keydown', this.onKeyDown);
    window.removeEventListener('keyup', this.onKeyUp);
  }

  read(): CarInput {
    const throttleKey = this.pressed.has('ArrowUp') || this.pressed.has('KeyW') ? 1 : 0;
    const brakeKey =
      this.pressed.has('ArrowDown') || this.pressed.has('KeyS') || this.pressed.has('Space') ? 1 : 0;
    const steerKey =
      (this.pressed.has('ArrowLeft') || this.pressed.has('KeyA') ? -1 : 0) +
      (this.pressed.has('ArrowRight') || this.pressed.has('KeyD') ? 1 : 0);

    return {
      throttle: Math.max(throttleKey, this.touchThrottle),
      brake: Math.max(brakeKey, this.touchBrake),
      steer: clamp(steerKey + this.touchSteer, -1, 1),
    };
  }

  consumeRetry(): boolean {
    const r = this.retryRequested;
    this.retryRequested = false;
    return r;
  }

  consumeNext(): boolean {
    const r = this.nextRequested;
    this.nextRequested = false;
    return r;
  }

  private onKeyDown = (e: KeyboardEvent): void => {
    if (TRACKED_KEYS.has(e.code)) {
      this.pressed.add(e.code);
      e.preventDefault();
    }
    if (e.code === 'KeyR') this.retryRequested = true;
    if (e.code === 'KeyN' || e.code === 'Enter') this.nextRequested = true;
  };

  private onKeyUp = (e: KeyboardEvent): void => {
    if (TRACKED_KEYS.has(e.code)) {
      this.pressed.delete(e.code);
      e.preventDefault();
    }
  };

  private bindMobileControls(): void {
    // слева газ/тормоз (▲/▼), справа руль (◀/▶) — простые кнопки-удержания
    let steerLeft = 0;
    let steerRight = 0;
    const applySteer = (): void => {
      this.touchSteer = steerRight - steerLeft;
    };
    bindHoldButton('btn-accel', (v) => { this.touchThrottle = v; });
    bindHoldButton('btn-reverse', (v) => { this.touchBrake = v; });
    bindHoldButton('btn-steer-left', (v) => { steerLeft = v; applySteer(); });
    bindHoldButton('btn-steer-right', (v) => { steerRight = v; applySteer(); });
  }

  private bindButtons(): void {
    for (const id of ['btn-retry', 'btn-overlay-retry']) {
      document.getElementById(id)?.addEventListener('click', () => {
        this.retryRequested = true;
      });
    }
    for (const id of ['btn-next', 'btn-overlay-next']) {
      document.getElementById(id)?.addEventListener('click', () => {
        this.nextRequested = true;
      });
    }
  }
}

function bindHoldButton(id: string, onChange: (v: number) => void): void {
  const el = document.getElementById(id);
  if (!el) return;
  const press = (e: Event): void => { onChange(1); e.preventDefault(); };
  const release = (e: Event): void => { onChange(0); e.preventDefault(); };
  el.addEventListener('touchstart', press, { passive: false });
  el.addEventListener('touchend', release);
  el.addEventListener('touchcancel', release);
  el.addEventListener('mousedown', press);
  el.addEventListener('mouseup', release);
  el.addEventListener('mouseleave', release);
}

function clamp(v: number, a: number, b: number): number {
  return Math.max(a, Math.min(b, v));
}
