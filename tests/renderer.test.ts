import { describe, expect, it } from 'vitest';
import { signSpot } from '../src/ui/Renderer';
import { cross } from './helpers/fixtures';

describe('Renderer: место знака (анти-оверлап)', () => {
  // знак у восточного луча: 14.5 м от центра узла, 6.1 м южнее осевой;
  // away — против хода (к перекрёстку), как у знака зебры
  const pos = { x: 14.5, y: 6.1 };
  const away = { x: -1, y: 0 };

  it('свободное место — без сдвига', () => {
    const m = cross();
    expect(signSpot(m, pos, away, [])).toEqual(pos);
  });

  it('занятое место — сдвиг вдоль away', () => {
    const m = cross();
    const p = signSpot(m, pos, away, [pos]);
    expect(p.x).toBeCloseTo(14.5 - 3.4, 5);
    expect(p.y).toBeCloseTo(6.1, 5);
  });

  it('не выталкивается на перекрёсток/полотно — уходит в обратную сторону', () => {
    const m = cross();
    // всё между знаком и узлом занято (светофор, лимит, односторонка...):
    // раньше знак доезжал до угла перекрёстка — на полотно поперечной дороги
    const placed = [
      { x: 14.5, y: 6.1 },
      { x: 11.1, y: 6.1 },
      { x: 7.7, y: 6.1 },
    ];
    const p = signSpot(m, pos, away, placed);
    expect(m.isOnRoad(p), `знак на полотне: ${p.x},${p.y}`).toBe(false);
    for (let i = 0; i < m.nodes.length; i++) {
      expect(m.inNodeArea(i, p), `знак в зоне узла ${i}`).toBe(false);
    }
    for (const q of placed) {
      expect(Math.hypot(q.x - p.x, q.y - p.y)).toBeGreaterThanOrEqual(3.4);
    }
  });
});
