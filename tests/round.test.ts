import { describe, expect, it } from 'vitest';
import { CityMap } from '../src/game/CityMap';
import type { Level } from '../src/game/generate';
import { BASE_SCORE, Round, computeScore } from '../src/game/Round';
import type { CitySpec } from '../src/game/types';
import { cross } from './helpers/fixtures';

const N = -Math.PI / 2;
const DT = 1 / 60;

function plan(map: CityMap, spawn: { x: number; y: number; heading: number }, goal: { x: number; y: number }): Level {
  return {
    seed: 1,
    spec: { nodes: map.nodes, edges: map.edges, buildings: map.buildings },
    map,
    spawn,
    spawnNode: 0,
    goal,
    goalNode: 0,
    routeLen: Math.hypot(goal.x - spawn.x, goal.y - spawn.y),
  };
}

describe('computeScore', () => {
  it('быстрое чистое прохождение — полный балл', () => {
    expect(computeScore(60, 45, 0)).toBe(BASE_SCORE);
    expect(computeScore(60, 60, 0)).toBe(BASE_SCORE);
  });

  it('время сверх par срезает очки пропорционально', () => {
    expect(computeScore(60, 120, 0)).toBe(BASE_SCORE / 2);
  });

  it('нарушения штрафуются, но не в минус', () => {
    expect(computeScore(60, 60, 2)).toBe(BASE_SCORE - 300);
    expect(computeScore(60, 600, 10)).toBe(0);
  });
});

describe('Round: игровой цикл', () => {
  it('время идёт, машина едет по газу', () => {
    const map = cross();
    const r = new Round(plan(map, { x: 2.25, y: 60, heading: N }, { x: 2.25, y: -60 }), { trafficCount: 0 });
    const y0 = r.car.position.y;
    for (let i = 0; i < 60; i++) r.step(DT, { throttle: 1, brake: 0, steer: 0 });
    expect(r.time).toBeCloseTo(1, 1);
    expect(r.car.position.y).toBeLessThan(y0 - 1);
    expect(r.finished).toBe(false);
  });

  it('достижение цели завершает раунд с полным баллом', () => {
    const map = cross();
    const r = new Round(plan(map, { x: 2.25, y: 60, heading: N }, { x: 2.25, y: 20 }), { trafficCount: 0 });
    for (let i = 0; i < 600 && !r.finished; i++) {
      r.step(DT, { throttle: 1, brake: 0, steer: 0 });
    }
    expect(r.finished).toBe(true);
    expect(r.violations).toHaveLength(0);
    expect(r.score).toBe(BASE_SCORE);
  });

  it('нарушение по пути снижает счёт', () => {
    const map = cross();
    // спавн на встречной полосе
    const r = new Round(plan(map, { x: -2.25, y: 60, heading: N }, { x: -2.25, y: 20 }), { trafficCount: 0 });
    for (let i = 0; i < 600 && !r.finished; i++) {
      r.step(DT, { throttle: 1, brake: 0, steer: 0 });
    }
    expect(r.finished).toBe(true);
    expect(r.violations.map((v) => v.type)).toContain('wrong-way');
    expect(r.score).toBeLessThan(BASE_SCORE);
  });

  it('дом — твёрдое препятствие: не проехать насквозь, столкновение засчитано', () => {
    const spec: CitySpec = {
      nodes: [{ x: 0, y: 0 }, { x: 200, y: 0 }],
      edges: [{ a: 0, b: 1 }],
      buildings: [{ xMin: 60, xMax: 80, yMin: -5, yMax: 5 }],
    };
    const map = new CityMap(spec);
    const r = new Round(plan(map, { x: 20, y: 2.25, heading: 0 }, { x: 190, y: 2.25 }), { trafficCount: 0 });
    for (let i = 0; i < 600; i++) {
      r.step(DT, { throttle: 1, brake: 0, steer: 0 });
      expect(r.car.position.x).toBeLessThan(58.7);
    }
    expect(r.violations.map((v) => v.type)).toContain('collision');
    expect(r.finished).toBe(false);
  });

  it('удар в дом на скорости с рулём не запирает машину в доме', () => {
    const spec: CitySpec = {
      nodes: [{ x: 0, y: 0 }, { x: 200, y: 0 }],
      edges: [{ a: 0, b: 1 }],
      buildings: [{ xMin: 60, xMax: 80, yMin: -5, yMax: 5 }],
    };
    const map = new CityMap(spec);
    const r = new Round(plan(map, { x: 30, y: 2.25, heading: 0 }, { x: 190, y: 2.25 }), { trafficCount: 0 });
    // разгон в стену, руль — перед самым ударом: кузов вращается в момент
    // контакта, углом
    for (let i = 0; i < 240 && r.car.position.x < 56; i++) {
      r.step(DT, { throttle: 1, brake: 0, steer: 0 });
    }
    for (let i = 0; i < 60; i++) r.step(DT, { throttle: 1, brake: 0, steer: -1 });
    expect(r.violations.map((v) => v.type)).toContain('collision');
    // задним ходом можно уехать от дома
    const x0 = r.car.position.x;
    for (let i = 0; i < 240; i++) r.step(DT, { throttle: 0, brake: 1, steer: 0 });
    expect(r.car.position.x).toBeLessThan(x0 - 1);
  });

  it('раунд с трафиком детерминирован по seed', () => {
    const run = (): string => {
      const map = cross();
      const r = new Round(plan(map, { x: 2.25, y: 80, heading: N }, { x: 2.25, y: -80 }), { trafficCount: 3 });
      for (let i = 0; i < 300; i++) r.step(DT, { throttle: 0.5, brake: 0, steer: 0 });
      return JSON.stringify([r.car.position, r.traffic.vehicleViews()]);
    };
    expect(run()).toBe(run());
  });
});
