import { describe, expect, it } from 'vitest';
import { GOAL_RADIUS, MIN_GOAL_HOPS, generateLevel } from '../src/game/generate';
import { HALF_ROAD } from '../src/game/CityMap';
import type { Rect } from '../src/game/types';

const SEEDS = [1, 2, 3, 7, 42, 123, 999, 20260709];

function rectsOverlap(a: Rect, b: Rect): boolean {
  return a.xMin < b.xMax && b.xMin < a.xMax && a.yMin < b.yMax && b.yMin < a.yMax;
}

describe('generateLevel: детерминизм', () => {
  it('один seed — одинаковый город, разные — разные', () => {
    const a = generateLevel(42);
    const b = generateLevel(42);
    const c = generateLevel(43);
    expect(JSON.stringify(a.spec)).toBe(JSON.stringify(b.spec));
    expect(JSON.stringify(a.spec)).not.toBe(JSON.stringify(c.spec));
  });
});

describe('generateLevel: инварианты для пачки seed', () => {
  for (const seed of SEEDS) {
    it(`seed=${seed}: структура города корректна`, () => {
      const level = generateLevel(seed);
      const m = level.map;

      // все рёбра осеориентированы (CityMap кидает исключение, если нет)
      // и не дублируются
      const keys = new Set<string>();
      for (const e of m.edges) {
        const k = [Math.min(e.a, e.b), Math.max(e.a, e.b)].join('-');
        expect(keys.has(k)).toBe(false);
        keys.add(k);
        expect(e.a).not.toBe(e.b);
      }

      // город строго связный (с учётом односторонних)
      for (let i = 1; i < m.nodes.length; i++) {
        expect(m.route(0, i), `нет пути 0→${i}`).not.toBeNull();
        expect(m.route(i, 0), `нет пути ${i}→0`).not.toBeNull();
      }

      // в городе есть жизнь: перекрёстки со светофорами или знаками
      const controlled = m.nodes.filter((n) => n.control === 'lights' || n.control === 'priority');
      expect(controlled.length).toBeGreaterThan(0);

      // регулирование корректно: у priority главная ось существует с обеих
      // сторон, светофоры и знаки — только на перекрёстках (degree >= 3)
      m.nodes.forEach((n, id) => {
        if (n.control === 'priority') {
          expect(m.degree(id)).toBeGreaterThanOrEqual(3);
          const sides = m.nodeEdges(id);
          if (n.mainAxis === 'h') {
            expect(sides.E).toBeDefined();
            expect(sides.W).toBeDefined();
          } else {
            expect(sides.N).toBeDefined();
            expect(sides.S).toBeDefined();
          }
          expect(n.minorSign).toBeDefined();
        }
        if (n.control === 'lights') {
          expect(m.degree(id)).toBeGreaterThanOrEqual(3);
        }
      });

      // зебры не ближе 12 м к перекрёсткам
      for (const cw of m.crosswalks()) {
        expect(cw.at).toBeGreaterThanOrEqual(12);
        expect(cw.at).toBeLessThanOrEqual(m.edgeLen(cw.edge) - 12);
      }

      // кольца — только на перекрёстках (нужны въезды-выезды)
      m.nodes.forEach((n, id) => {
        if (n.control === 'roundabout') {
          expect(m.degree(id)).toBeGreaterThanOrEqual(3);
        }
      });

      // ЖД-переезды: не больше двух, в глубине ребра и не вместе с зеброй
      const rails = m.railways();
      expect(rails.length).toBeLessThanOrEqual(2);
      for (const rw of rails) {
        expect(rw.at).toBeGreaterThanOrEqual(20);
        expect(rw.at).toBeLessThanOrEqual(m.edgeLen(rw.edge) - 20);
        expect(m.edges[rw.edge].crosswalks).toBeUndefined();
      }

      // «разворот запрещён» — только на перекрёстках и не на кольцах
      m.nodes.forEach((n, id) => {
        if (n.noUTurn) {
          expect(m.degree(id)).toBeGreaterThanOrEqual(3);
          expect(n.control).not.toBe('roundabout');
        }
      });
    });

    it(`seed=${seed}: дома не пересекают дороги`, () => {
      const level = generateLevel(seed);
      const m = level.map;
      const roadRects: Rect[] = [];
      for (let i = 0; i < m.edges.length; i++) roadRects.push(m.edgeRoadRect(i));
      for (let i = 0; i < m.nodes.length; i++) {
        const b = m.nodeBox(i);
        roadRects.push({
          xMin: b.xMin - 1, xMax: b.xMax + 1,
          yMin: b.yMin - 1, yMax: b.yMax + 1,
        });
      }
      expect(m.buildings.length).toBeGreaterThan(0);
      for (const bld of m.buildings) {
        for (const r of roadRects) {
          expect(rectsOverlap(bld, r)).toBe(false);
        }
      }
    });

    it(`seed=${seed}: спавн и цель валидны`, () => {
      const level = generateLevel(seed);
      const m = level.map;
      // спавн на дороге, по направлению полосы
      expect(m.isOnRoad(level.spawn)).toBe(true);
      const lane = m.nearestLane(level.spawn);
      expect(lane).not.toBeNull();
      // цель на дороге и достаточно далеко
      expect(m.isOnRoad(level.goal)).toBe(true);
      const hops = m.route(level.spawnNode, level.goalNode)?.edges.length;
      expect(hops).toBeGreaterThanOrEqual(MIN_GOAL_HOPS);
      // прямое расстояние больше радиуса зачёта
      const d = Math.hypot(level.goal.x - level.spawn.x, level.goal.y - level.spawn.y);
      expect(d).toBeGreaterThan(GOAL_RADIUS * 3);
      // par-дистанция положительная
      expect(level.routeLen).toBeGreaterThan(0);
    });
  }
});

describe('generateLevel: новые кейсы встречаются', () => {
  it('на пачке сидов попадаются кольца, оба вида ЖД-переездов и знак 431', () => {
    let rings = 0;
    let railSigns = 0;
    let railLights = 0;
    let noUTurns = 0;
    for (let seed = 1; seed <= 40; seed++) {
      const m = generateLevel(seed).map;
      rings += m.nodes.filter((n) => n.control === 'roundabout').length;
      railSigns += m.railways().filter((r) => !r.light).length;
      railLights += m.railways().filter((r) => r.light).length;
      noUTurns += m.nodes.filter((n) => n.noUTurn).length;
    }
    expect(rings).toBeGreaterThan(10);
    expect(railSigns).toBeGreaterThan(5);
    expect(railLights).toBeGreaterThan(5);
    expect(noUTurns).toBeGreaterThan(10);
  });
});

describe('generateLevel: односторонки целыми улицами', () => {
  it('на узлах без перекрёстка (degree <= 2) режим движения непрерывен', () => {
    for (let seed = 1; seed <= 60; seed++) {
      const m = generateLevel(seed).map;
      m.nodes.forEach((_, id) => {
        const eids = Object.values(m.nodeEdges(id)).filter(
          (k): k is number => k !== undefined,
        );
        const msg = `seed=${seed}, узел ${id}`;
        // тупик: односторонка в тупик — ловушка
        if (eids.length === 1) {
          expect(m.edges[eids[0]].oneWay, msg).toBeUndefined();
          return;
        }
        if (eids.length !== 2) return;
        // стык «односторонка ↔ двусторонка» посреди улицы запрещён:
        // встречному потоку негде свернуть
        const [e1, e2] = eids.map((k) => m.edges[k]);
        expect(Boolean(e1.oneWay), msg).toBe(Boolean(e2.oneWay));
        // обе односторонние — поток сквозной: одна входит, другая выходит
        if (e1.oneWay && e2.oneWay) {
          const into = [e1, e2].filter((e) => e.b === id).length;
          expect(into, msg).toBe(1);
        }
      });
    }
  });
});

describe('generateLevel: дороги не наезжают друг на друга', () => {
  it('параллельные улицы разнесены минимум на ширину дома', () => {
    for (const seed of SEEDS) {
      const m = generateLevel(seed).map;
      // расстояние между параллельными рёбрами с пересекающейся проекцией
      for (let i = 0; i < m.edges.length; i++) {
        for (let j = i + 1; j < m.edges.length; j++) {
          const shared = sharedNode(m.edges[i], m.edges[j]);
          if (shared !== null) continue;
          const ri = m.edgeRoadRect(i);
          const rj = m.edgeRoadRect(j);
          expect(rectsOverlap(ri, rj), `рёбра ${i} и ${j} пересеклись (seed=${seed})`).toBe(false);
        }
      }
      // ширина полотна согласована с константой
      expect(HALF_ROAD).toBe(4.5);
    }
  });
});

function sharedNode(a: { a: number; b: number }, b: { a: number; b: number }): number | null {
  for (const n of [a.a, a.b]) {
    if (n === b.a || n === b.b) return n;
  }
  return null;
}
