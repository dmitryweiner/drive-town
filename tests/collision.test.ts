import { describe, it, expect } from 'vitest';
import { obbIntersect, OBB } from '../src/game/Collision';

const box = (cx: number, cy: number, hx: number, hy: number, angle = 0): OBB => ({
  cx,
  cy,
  hx,
  hy,
  angle,
});

describe('OBB SAT collision', () => {
  it('detects overlap of two axis-aligned boxes', () => {
    expect(obbIntersect(box(0, 0, 1, 1), box(1, 0, 1, 1))).toBe(true);
  });

  it('returns false for clearly separated boxes', () => {
    expect(obbIntersect(box(0, 0, 1, 1), box(5, 0, 1, 1))).toBe(false);
    expect(obbIntersect(box(0, 0, 1, 1), box(0, 5, 1, 1))).toBe(false);
  });

  it('handles rotated boxes', () => {
    const a = box(0, 0, 2, 0.5, 0);
    const b = box(2, 0, 2, 0.5, Math.PI / 2); // tall vertical box at x=2
    expect(obbIntersect(a, b)).toBe(true);

    const c = box(5, 5, 0.5, 0.5, Math.PI / 4);
    expect(obbIntersect(a, c)).toBe(false);
  });

  it('is symmetric', () => {
    const a = box(0, 0, 1, 2, 0.3);
    const b = box(1.5, 0.5, 0.7, 1.2, -0.4);
    expect(obbIntersect(a, b)).toBe(obbIntersect(b, a));
  });

  it('touching edges count as intersection', () => {
    expect(obbIntersect(box(0, 0, 1, 1), box(2, 0, 1, 1))).toBe(true);
  });
});
