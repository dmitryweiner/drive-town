import { describe, expect, it } from 'vitest';
import {
  CityMap,
  HALF_ROAD,
  LANE_OFF,
  RAIL_CYCLE,
  RAIL_FLASH,
  RAIL_HALF,
  ROUNDABOUT_ISLAND_R,
  ROUNDABOUT_R,
  STOP_LINE_OFFSET,
} from '../src/game/CityMap';
import type { CitySpec } from '../src/game/types';
import { cross } from './helpers/fixtures';

/** Тестовый город:
 *
 *   0 ──e0── 1 ──e4→─ 4        y=0
 *   │        │
 *   e1       e2
 *   │        │
 *   2 ──e3── 3                 y=90
 *
 * e4 — односторонняя (1→4). На e3 зебра в 60 м от узла 2 и лимит 30.
 * Узел 3 — светофор; узел 1 — главная дорога по горизонтали, минорный
 * подъезд со «стоп»; узел 0 — угол; узел 4 — тупик.
 */
function spec(): CitySpec {
  return {
    nodes: [
      { x: 0, y: 0 },
      { x: 120, y: 0, control: 'priority', mainAxis: 'h', minorSign: 'stop' },
      { x: 0, y: 90 },
      { x: 120, y: 90, control: 'lights', lightOffset: 0 },
      { x: 200, y: 0 },
    ],
    edges: [
      { a: 0, b: 1 },
      { a: 0, b: 2 },
      { a: 1, b: 3 },
      { a: 2, b: 3, speedLimit: 30, crosswalks: [60] },
      { a: 1, b: 4, oneWay: true },
    ],
  };
}

const map = () => new CityMap(spec());

describe('CityMap: граф и стороны', () => {
  it('раскладывает рёбра узла по сторонам света', () => {
    const m = map();
    expect(m.nodeEdges(0)).toEqual({ E: 0, S: 1 });
    expect(m.nodeEdges(1)).toEqual({ W: 0, S: 2, E: 4 });
    expect(m.nodeEdges(4)).toEqual({ W: 4 });
  });

  it('approachSide: с какой стороны узла присоединено ребро', () => {
    const m = map();
    expect(m.approachSide(1, 0)).toBe('W');
    expect(m.approachSide(1, 2)).toBe('S');
    expect(m.approachSide(3, 3)).toBe('W');
  });

  it('degree: перекрёсток/угол/тупик', () => {
    const m = map();
    expect(m.degree(1)).toBe(3);
    expect(m.degree(0)).toBe(2);
    expect(m.degree(4)).toBe(1);
  });
});

describe('CityMap: полотно дороги', () => {
  it('точки на ребре и в квадрате узла — на дороге', () => {
    const m = map();
    expect(m.isOnRoad({ x: 60, y: 2 })).toBe(true);       // на e0
    expect(m.isOnRoad({ x: 60, y: -4.4 })).toBe(true);    // край e0
    expect(m.isOnRoad({ x: 0, y: 0 })).toBe(true);        // центр узла 0
    expect(m.isOnRoad({ x: 123, y: 3 })).toBe(true);      // квадрат узла 1
  });

  it('точки вне полотна — не на дороге', () => {
    const m = map();
    expect(m.isOnRoad({ x: 60, y: 5.2 })).toBe(false);    // сбоку от e0
    expect(m.isOnRoad({ x: -30, y: -30 })).toBe(false);   // чистое поле
    expect(m.isOnRoad({ x: 60, y: 45 })).toBe(false);     // внутри квартала
  });

  it('углы узлов скруглены подушками', () => {
    const m = map();
    // угол квадрата узла 0: (4.5, 4.5); точка чуть дальше по диагонали
    expect(m.isOnRoad({ x: 5.3, y: 5.3 })).toBe(true);
    expect(m.isOnRoad({ x: 6.5, y: 6.5 })).toBe(false);
  });
});

describe('CityMap: полосы', () => {
  it('центр полосы — справа по ходу движения', () => {
    const m = map();
    // e0 горизонтальное: едем на восток (a→b) — полоса южнее осевой
    expect(m.lanePoint(0, 1, 60)).toEqual({ x: 60, y: LANE_OFF });
    // едем на запад (b→a) — полоса севернее осевой
    expect(m.lanePoint(0, -1, 60)).toEqual({ x: 60, y: -LANE_OFF });
    // e1 вертикальное: на юг — полоса западнее? нет: справа по ходу на юг — x отрицательный?
    // едем на юг (a→b): право по ходу — на запад... в canvas право от (0,1) — это (-1,0)
    expect(m.lanePoint(1, 1, 45)).toEqual({ x: -LANE_OFF, y: 45 });
  });

  it('nearestLane находит ребро, направление и продольную координату', () => {
    const m = map();
    const l1 = m.nearestLane({ x: 60, y: 1.8 });
    expect(l1).not.toBeNull();
    expect(l1?.edge).toBe(0);
    expect(l1?.dirSign).toBe(1);
    expect(l1?.along).toBeCloseTo(60, 5);

    const l2 = m.nearestLane({ x: 60, y: -1 });
    expect(l2?.dirSign).toBe(-1);
  });

  it('на односторонней обе половины считаются попутными', () => {
    const m = map();
    expect(m.nearestLane({ x: 160, y: 2 })?.dirSign).toBe(1);
    expect(m.nearestLane({ x: 160, y: -2 })?.dirSign).toBe(1);
    expect(m.allowedDirSigns(4)).toEqual([1]);
    expect(m.allowedDirSigns(0)).toEqual([1, -1]);
  });
});

describe('CityMap: стоп-линии и повороты', () => {
  it('расстояние до стоп-линии перед узлом', () => {
    const m = map();
    // едем по e0 на восток к узлу 1 (x=120): стоп-линия на x = 120-4.5-1
    const d = m.distToStopLine(1, 0, { x: 110, y: LANE_OFF });
    expect(d).toBeCloseTo(120 - HALF_ROAD - STOP_LINE_OFFSET - 110, 5);
    // уже за линией — отрицательное
    expect(m.distToStopLine(1, 0, { x: 118, y: LANE_OFF })).toBeLessThan(0);
  });

  it('прямой проезд узла — отрезок между граничными точками полос', () => {
    const m = map();
    // через узел 1 с запада на восток (e0 → e4)
    const pts = m.turnPath(1, 0, 4);
    expect(pts[0]).toEqual({ x: 120 - HALF_ROAD, y: LANE_OFF });
    expect(pts[pts.length - 1]).toEqual({ x: 120 + HALF_ROAD, y: LANE_OFF });
  });

  it('поворот — гладкая дуга, конец на полосе выезда', () => {
    const m = map();
    // правый поворот: с e0 (на восток) на e2 (на юг) в узле 1
    const pts = m.turnPath(1, 0, 2);
    const last = pts[pts.length - 1];
    expect(last.x).toBeCloseTo(120 - LANE_OFF, 5); // полоса на юг — западнее осевой
    // все точки — на дороге
    for (const p of pts) expect(m.isOnRoad(p)).toBe(true);
    // сегменты не разворачиваются назад (движение монотонно вперёд)
    for (let i = 1; i < pts.length - 1; i++) {
      const ux = pts[i].x - pts[i - 1].x, uy = pts[i].y - pts[i - 1].y;
      const vx = pts[i + 1].x - pts[i].x, vy = pts[i + 1].y - pts[i].y;
      expect(ux * vx + uy * vy).toBeGreaterThanOrEqual(0);
    }
  });

  // ПДД Израиля: тк. 42 — правый поворот в правую полосу; тк. 43 — левый
  // на односторонку (две полосы одного направления) — в ЛЕВУЮ полосу
  it('левый поворот на односторонку кончается в левой полосе', () => {
    const m = cross({ oneWayE: true });
    // с севера (e0, курс на юг) налево на восток (e1)
    const pts = m.turnPath(0, 0, 1);
    const last = pts[pts.length - 1];
    expect(last.y).toBeCloseTo(-LANE_OFF, 5);
    for (const p of pts) expect(m.isOnRoad(p), `точка вне дороги: ${p.x},${p.y}`).toBe(true);
  });

  it('правый поворот на односторонку — в правой полосе', () => {
    const m = cross({ oneWayE: true });
    // с юга (e2, курс на север) направо на восток
    const pts = m.turnPath(0, 2, 1);
    expect(pts[pts.length - 1].y).toBeCloseTo(LANE_OFF, 5);
  });

  it('левый поворот на двустороннюю — в полосе своего направления', () => {
    const m = cross();
    const pts = m.turnPath(0, 0, 1);
    expect(pts[pts.length - 1].y).toBeCloseTo(LANE_OFF, 5);
  });
});

describe('CityMap: светофоры', () => {
  it('вертикальные подъезды зелёные первыми, горизонтальные — во второй фазе', () => {
    const m = map();
    // узел 3: подъезд с севера (ребро e2 на стороне N) и с запада (e3 на W)
    expect(m.lightState(3, 'N', 0)).toBe('green');
    expect(m.lightState(3, 'W', 0)).toBe('red');
    expect(m.lightState(3, 'N', 8.5)).toBe('yellow');
    expect(m.lightState(3, 'N', 11)).toBe('red');
    expect(m.lightState(3, 'W', 9.5)).toBe('red-yellow');
    expect(m.lightState(3, 'W', 10.5)).toBe('green');
    expect(m.lightState(3, 'W', 19)).toBe('yellow');
    // цикл замыкается
    expect(m.lightState(3, 'N', 20)).toBe('green');
  });

  it('на узле без светофора состояния нет', () => {
    const m = map();
    expect(m.lightState(1, 'W', 0)).toBeNull();
  });
});

describe('CityMap: зебры и лимиты', () => {
  it('зебра на e3 — поперечная полоса на всю ширину дороги', () => {
    const m = map();
    const cw = m.crosswalks();
    expect(cw).toHaveLength(1);
    expect(cw[0].edge).toBe(3);
    expect(cw[0].rect).toEqual({
      xMin: 58.5, xMax: 61.5,
      yMin: 90 - HALF_ROAD, yMax: 90 + HALF_ROAD,
    });
  });

  it('лимит скорости: с ребра или городской дефолт', () => {
    const m = map();
    expect(m.speedLimitAt({ x: 60, y: 91 })).toBe(30);  // e3
    expect(m.speedLimitAt({ x: 60, y: 1 })).toBe(50);   // e0, дефолт
  });
});

/** Крест с кольцом в центре (узел 0) и ЖД-переездом на южном ребре. */
function ringSpec(): CitySpec {
  return {
    nodes: [
      { x: 0, y: 0, control: 'roundabout' },
      { x: 0, y: -100 },
      { x: 100, y: 0 },
      { x: 0, y: 100 },
      { x: -100, y: 0 },
    ],
    edges: [
      { a: 1, b: 0 },                    // e0: с севера
      { a: 0, b: 2 },                    // e1: на восток
      { a: 0, b: 3, railways: [50] },    // e2: на юг
      { a: 4, b: 0 },                    // e3: с запада
    ],
  };
}

const ring = () => new CityMap(ringSpec());

describe('CityMap: круговое движение', () => {
  it('радиус узла: кольцо шире обычного квадрата', () => {
    const m = ring();
    expect(m.nodeRadius(0)).toBe(ROUNDABOUT_R);
    expect(m.nodeRadius(1)).toBe(HALF_ROAD);
    expect(ROUNDABOUT_R).toBeGreaterThan(HALF_ROAD);
  });

  it('стоп-линия подъезда — перед внешним краем кольца', () => {
    const m = ring();
    // едем по e2 с юга к узлу 0: стоп-линия на y = ROUNDABOUT_R + 1
    const d = m.distToStopLine(0, 2, { x: LANE_OFF, y: 30 });
    expect(d).toBeCloseTo(30 - ROUNDABOUT_R - STOP_LINE_OFFSET, 5);
  });

  it('островок — не дорога, кольцо и горловины — дорога', () => {
    const m = ring();
    expect(m.isOnRoad({ x: 0, y: 0 })).toBe(false);           // центр островка
    expect(m.isOnRoad({ x: ROUNDABOUT_ISLAND_R - 0.3, y: 0 })).toBe(false);
    expect(m.isOnRoad({ x: ROUNDABOUT_ISLAND_R + 2.25, y: 0 })).toBe(true); // полоса кольца
    expect(m.isOnRoad({ x: 0, y: -(ROUNDABOUT_R - 0.5) })).toBe(true);      // у внешнего края
    expect(m.isOnRoad({ x: 4.6, y: 7.9 })).toBe(true);        // стык горловины и кольца
    expect(m.isOnRoad({ x: ROUNDABOUT_R + 1.7, y: ROUNDABOUT_R + 1.7 })).toBe(false);
  });

  it('в зоне узла — по кругу, а не по квадрату', () => {
    const m = ring();
    expect(m.inNodeArea(0, { x: 0, y: -(ROUNDABOUT_R - 0.1) })).toBe(true); // далеко за квадратом
    expect(m.inNodeArea(0, { x: 6.5, y: 6.5 })).toBe(false);  // диагональ вне круга
    expect(m.inNodeArea(1, { x: 3, y: -103 })).toBe(true);    // обычный узел — квадрат
  });

  const withinRing = (m: CityMap, pts: { x: number; y: number }[]): void => {
    for (const p of pts) {
      const d = Math.hypot(p.x, p.y);
      // внутри кольца путь не залезает на островок
      if (d < ROUNDABOUT_R) expect(d).toBeGreaterThan(ROUNDABOUT_ISLAND_R + 0.9);
      expect(m.isOnRoad(p)).toBe(true);
    }
  };

  it('прямо через кольцо: путь огибает островок по ходу движения', () => {
    const m = ring();
    // с юга (e2) на север (e0): въезд по полосе x=+LANE_OFF
    const pts = m.turnPath(0, 2, 0);
    expect(pts[0].x).toBeCloseTo(LANE_OFF, 5);
    expect(pts[0].y).toBeGreaterThan(0);
    const last = pts[pts.length - 1];
    expect(last.x).toBeCloseTo(LANE_OFF, 5);
    expect(last.y).toBeLessThan(0);
    withinRing(m, pts);
    // движение монотонно вперёд (без разворотов сегментов)
    for (let i = 1; i < pts.length - 1; i++) {
      const ux = pts[i].x - pts[i - 1].x, uy = pts[i].y - pts[i - 1].y;
      const vx = pts[i + 1].x - pts[i].x, vy = pts[i + 1].y - pts[i].y;
      expect(ux * vx + uy * vy).toBeGreaterThanOrEqual(0);
    }
  });

  it('левый поворот и разворот идут по кольцу против часовой (на экране)', () => {
    const m = ring();
    // с юга на запад (левый): выезд по полосе y=-LANE_OFF
    const left = m.turnPath(0, 2, 3);
    const lastL = left[left.length - 1];
    expect(lastL.y).toBeCloseTo(-LANE_OFF, 5);
    expect(lastL.x).toBeLessThan(0);
    withinRing(m, left);
    // разворот: обратно на e2 по встречной полосе x=-LANE_OFF
    const u = m.turnPath(0, 2, 2);
    const lastU = u[u.length - 1];
    expect(lastU.x).toBeCloseTo(-LANE_OFF, 5);
    expect(lastU.y).toBeGreaterThan(0);
    withinRing(m, u);
  });

  it('правый поворот — короткая дуга, не через всё кольцо', () => {
    const m = ring();
    const pts = m.turnPath(0, 2, 1); // с юга на восток
    const last = pts[pts.length - 1];
    expect(last.y).toBeCloseTo(LANE_OFF, 5);
    expect(last.x).toBeGreaterThan(0);
    withinRing(m, pts);
    let len = 0;
    for (let i = 1; i < pts.length; i++) len += Math.hypot(pts[i].x - pts[i - 1].x, pts[i].y - pts[i - 1].y);
    expect(len).toBeLessThan(20); // а не ~30+ объезда всего кольца
  });
});

describe('CityMap: ЖД-переезды', () => {
  it('переезд на e2 — поперечная полоса на всю ширину дороги', () => {
    const m = ring();
    const rw = m.railways();
    expect(rw).toHaveLength(1);
    expect(rw[0].edge).toBe(2);
    expect(rw[0].at).toBe(50);
    expect(rw[0].light).toBe(false);
    expect(rw[0].axis).toBe('y'); // дорога вертикальна
    expect(rw[0].rect).toEqual({
      xMin: -HALF_ROAD, xMax: HALF_ROAD,
      yMin: 50 - RAIL_HALF, yMax: 50 + RAIL_HALF,
    });
  });

  it('переезд со светофором: мигание циклично, у знакового света нет', () => {
    const spec = ringSpec();
    spec.edges[2].railways = undefined;
    spec.edges[2].railLights = [50];
    const m = new CityMap(spec);
    expect(m.railways()[0].light).toBe(true);
    // окно мигания [0, RAIL_FLASH), затем тишина до конца цикла
    expect(m.railFlashing(0, 0)).toBe(true);
    expect(m.railFlashElapsed(0, 3)).toBeCloseTo(3);
    expect(m.railFlashing(0, RAIL_FLASH + 0.1)).toBe(false);
    expect(m.railFlashing(0, RAIL_CYCLE - 0.1)).toBe(false);
    expect(m.railFlashing(0, RAIL_CYCLE + 1)).toBe(true); // цикл замкнулся
    // у знакового переезда сигнала нет
    expect(ring().railFlashing(0, 0)).toBe(false);
  });
});

describe('CityMap: маршруты', () => {
  it('кратчайший маршрут по числу рёбер', () => {
    const m = map();
    const r = m.route(0, 3);
    if (!r) throw new Error('маршрут не найден');
    expect(r.nodes[0]).toBe(0);
    expect(r.nodes[r.nodes.length - 1]).toBe(3);
    expect(r.edges).toHaveLength(2);
  });

  it('односторонние рёбра проходимы только по направлению', () => {
    const m = map();
    expect(m.route(1, 4)).not.toBeNull();
    // из тупика 4 против односторонней e4 выезда нет
    expect(m.route(4, 2)).toBeNull();
  });
});
