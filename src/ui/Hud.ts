import type { Round } from '../game/Round';
import { VIOLATION_LABEL, type Violation } from '../game/types';

/** Шапка, всплывашки о нарушениях и оверлей завершения уровня. */
export class Hud {
  private readonly levelEl = byValue('level');
  private readonly timeEl = byValue('time');
  private readonly speedEl = byValue('speed');
  private readonly violationsEl = byValue('violations');
  private readonly distEl = byValue('dist');
  private readonly scoreEl = byValue('score');
  private readonly toastEl = document.getElementById('toast');
  private readonly overlayEl = document.getElementById('result-overlay');

  private lastSecond = -1;
  private lastSpeed = -1;
  private lastDist = -1;
  private overlayShown = false;
  private toastTimer: ReturnType<typeof setTimeout> | null = null;

  update(round: Round, level: number, totalScore: number): void {
    setText(this.levelEl, String(level));
    const sec = Math.floor(round.time);
    if (sec !== this.lastSecond) {
      this.lastSecond = sec;
      setText(this.timeEl, formatTime(sec));
    }
    const kmh = Math.round(Math.abs(round.car.velocity) * 3.6);
    if (kmh !== this.lastSpeed) {
      this.lastSpeed = kmh;
      setText(this.speedEl, String(kmh));
    }
    setText(this.violationsEl, String(round.violations.length));
    const dist = Math.round(round.goalDist);
    if (dist !== this.lastDist) {
      this.lastDist = dist;
      setText(this.distEl, String(dist));
    }
    setText(this.scoreEl, String(totalScore));

    if (round.finished && !this.overlayShown) {
      this.overlayShown = true;
      setText(byValue('result-time'), formatTime(Math.floor(round.time)));
      setText(byValue('result-violations'), String(round.violations.length));
      setText(byValue('result-violation-list'), summarizeViolations(round.violations));
      setText(byValue('result-score'), String(round.score));
      setText(byValue('result-total'), String(totalScore + round.score));
      this.overlayEl?.removeAttribute('hidden');
    } else if (!round.finished && this.overlayShown) {
      this.overlayShown = false;
      this.overlayEl?.setAttribute('hidden', '');
    }
  }

  /** Показывает нарушение на пару секунд. */
  toast(v: Violation): void {
    if (!this.toastEl) return;
    this.toastEl.textContent = `❗ ${VIOLATION_LABEL[v.type]}`;
    this.toastEl.removeAttribute('hidden');
    if (this.toastTimer) clearTimeout(this.toastTimer);
    this.toastTimer = setTimeout(() => this.toastEl?.setAttribute('hidden', ''), 2500);
  }
}

function summarizeViolations(violations: Violation[]): string {
  if (violations.length === 0) return 'Чистая езда! 👌';
  const counts = new Map<string, number>();
  for (const v of violations) {
    const label = VIOLATION_LABEL[v.type];
    counts.set(label, (counts.get(label) ?? 0) + 1);
  }
  return [...counts.entries()].map(([label, n]) => (n > 1 ? `${label} ×${n}` : label)).join(' · ');
}

function formatTime(sec: number): string {
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return `${m}:${String(s).padStart(2, '0')}`;
}

function byValue(name: string): HTMLElement | null {
  return document.querySelector(`[data-value="${name}"]`);
}

function setText(el: HTMLElement | null, text: string): void {
  if (el && el.textContent !== text) el.textContent = text;
}
