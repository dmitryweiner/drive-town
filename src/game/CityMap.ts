import type { Vec2 } from './Car';
import type { CitySpec, Dir, EdgeSpec, LightState, NodeSpec, Rect } from './types';

/** Ширина полосы (как в driving-trainer: с запасом на радиус манёвра). */
export const LANE_W = 4.5;
/** Полуширина полотна: все улицы 1+1 (или односторонние 2 полосы). */
export const HALF_ROAD = 4.5;
/** Смещение центра полосы от осевой. */
export const LANE_OFF = LANE_W / 2;
/** Стоп-линия — за метр до квадрата перекрёстка. */
export const STOP_LINE_OFFSET = 1;
/** Скругление углов тротуара (из driving-trainer, не убирать). */
const CURB_PAD = 1.5;
/** Городской лимит скорости по умолчанию, км/ч. */
export const DEFAULT_SPEED_LIMIT = 50;
/** Длина зебры вдоль дороги. */
export const CROSSWALK_LEN = 3;

/** Светофорный цикл: вертикальная группа (подъезды N/S) зелёная первой. */
const G = 8;
const Y = 2;
const RY = 1;
export const LIGHT_CYCLE = 2 * (G + Y);

export interface LanePos {
  edge: number;
  /** 1 — движение a→b, -1 — b→a. */
  dirSign: number;
  /** Метры от центра узла a вдоль оси ребра. */
  along: number;
  /** Поперечное смещение точки от осевой (со знаком, в сторону right(a→b)). */
  lateral: number;
}

export interface Crosswalk {
  edge: number;
  /** Метры от центра узла a. */
  at: number;
  rect: Rect;
  /** Ось ДОРОГИ ('x' — дорога горизонтальна, пешеход идёт по y). */
  axis: 'x' | 'y';
}

export interface Route {
  nodes: number[];
  edges: number[];
}

const DIRS: readonly Dir[] = ['N', 'E', 'S', 'W'];

export const DIR_VEC: Record<Dir, Vec2> = {
  N: { x: 0, y: -1 },
  E: { x: 1, y: 0 },
  S: { x: 0, y: 1 },
  W: { x: -1, y: 0 },
};

export function dirOfVec(v: Vec2): Dir {
  if (Math.abs(v.x) >= Math.abs(v.y)) return v.x >= 0 ? 'E' : 'W';
  return v.y >= 0 ? 'S' : 'N';
}

/** Правый перпендикуляр (canvas, y вниз): справа от «на восток» — юг. */
export function rightOf(v: Vec2): Vec2 {
  return { x: -v.y, y: v.x };
}

export function rectToOBBRect(r: Rect): { cx: number; cy: number; hx: number; hy: number; angle: number } {
  return {
    cx: (r.xMin + r.xMax) / 2,
    cy: (r.yMin + r.yMax) / 2,
    hx: (r.xMax - r.xMin) / 2,
    hy: (r.yMax - r.yMin) / 2,
    angle: 0,
  };
}

export class CityMap {
  readonly nodes: NodeSpec[];
  readonly edges: EdgeSpec[];
  readonly buildings: Rect[];
  private readonly nodeEdgeMap: Partial<Record<Dir, number>>[];
  private readonly crosswalkList: Crosswalk[];

  constructor(spec: CitySpec) {
    this.nodes = spec.nodes;
    this.edges = spec.edges;
    this.buildings = spec.buildings ?? [];
    this.nodeEdgeMap = this.nodes.map(() => ({}));
    this.edges.forEach((e, id) => {
      const a = this.nodes[e.a];
      const b = this.nodes[e.b];
      if (a.x !== b.x && a.y !== b.y) {
        throw new Error(`ребро ${id} не осеориентировано`);
      }
      const dirAB = dirOfVec({ x: b.x - a.x, y: b.y - a.y });
      this.nodeEdgeMap[e.a][dirAB] = id;
      this.nodeEdgeMap[e.b][opposite(dirAB)] = id;
    });
    this.crosswalkList = [];
    this.edges.forEach((e, id) => {
      for (const at of e.crosswalks ?? []) {
        const a = this.nodes[e.a];
        const u = this.edgeUnit(id);
        const cx = a.x + u.x * at;
        const cy = a.y + u.y * at;
        const horizontal = u.y === 0;
        this.crosswalkList.push({
          edge: id,
          at,
          axis: horizontal ? 'x' : 'y',
          rect: horizontal
            ? { xMin: cx - CROSSWALK_LEN / 2, xMax: cx + CROSSWALK_LEN / 2, yMin: cy - HALF_ROAD, yMax: cy + HALF_ROAD }
            : { xMin: cx - HALF_ROAD, xMax: cx + HALF_ROAD, yMin: cy - CROSSWALK_LEN / 2, yMax: cy + CROSSWALK_LEN / 2 },
        });
      }
    });
  }

  /** Рёбра узла по сторонам света. */
  nodeEdges(nodeId: number): Partial<Record<Dir, number>> {
    return this.nodeEdgeMap[nodeId];
  }

  degree(nodeId: number): number {
    return Object.keys(this.nodeEdgeMap[nodeId]).length;
  }

  /** Сторона узла, на которой присоединено ребро. */
  approachSide(nodeId: number, edgeId: number): Dir {
    for (const d of DIRS) {
      if (this.nodeEdgeMap[nodeId][d] === edgeId) return d;
    }
    throw new Error(`ребро ${edgeId} не присоединено к узлу ${nodeId}`);
  }

  /** Единичный вектор оси ребра a→b. */
  edgeUnit(edgeId: number): Vec2 {
    const e = this.edges[edgeId];
    const a = this.nodes[e.a];
    const b = this.nodes[e.b];
    const len = Math.hypot(b.x - a.x, b.y - a.y);
    return { x: (b.x - a.x) / len, y: (b.y - a.y) / len };
  }

  /** Расстояние между центрами узлов ребра. */
  edgeLen(edgeId: number): number {
    const e = this.edges[edgeId];
    const a = this.nodes[e.a];
    const b = this.nodes[e.b];
    return Math.hypot(b.x - a.x, b.y - a.y);
  }

  /** Квадрат перекрёстка. */
  nodeBox(nodeId: number): Rect {
    const n = this.nodes[nodeId];
    return {
      xMin: n.x - HALF_ROAD,
      xMax: n.x + HALF_ROAD,
      yMin: n.y - HALF_ROAD,
      yMax: n.y + HALF_ROAD,
    };
  }

  /** Полотно ребра между квадратами узлов. */
  edgeRoadRect(edgeId: number): Rect {
    const e = this.edges[edgeId];
    const a = this.nodes[e.a];
    const u = this.edgeUnit(edgeId);
    const len = this.edgeLen(edgeId);
    const sx = a.x + u.x * HALF_ROAD;
    const sy = a.y + u.y * HALF_ROAD;
    const ex = a.x + u.x * (len - HALF_ROAD);
    const ey = a.y + u.y * (len - HALF_ROAD);
    return {
      xMin: Math.min(sx, ex) - (u.y !== 0 ? HALF_ROAD : 0),
      xMax: Math.max(sx, ex) + (u.y !== 0 ? HALF_ROAD : 0),
      yMin: Math.min(sy, ey) - (u.x !== 0 ? HALF_ROAD : 0),
      yMax: Math.max(sy, ey) + (u.x !== 0 ? HALF_ROAD : 0),
    };
  }

  isOnRoad(p: Vec2): boolean {
    for (let i = 0; i < this.nodes.length; i++) {
      const b = this.nodeBox(i);
      if (p.x >= b.xMin && p.x <= b.xMax && p.y >= b.yMin && p.y <= b.yMax) return true;
      for (const cx of [b.xMin, b.xMax]) {
        for (const cy of [b.yMin, b.yMax]) {
          if (Math.hypot(p.x - cx, p.y - cy) <= CURB_PAD) return true;
        }
      }
    }
    for (let i = 0; i < this.edges.length; i++) {
      const r = this.edgeRoadRect(i);
      if (p.x >= r.xMin && p.x <= r.xMax && p.y >= r.yMin && p.y <= r.yMax) return true;
    }
    return false;
  }

  /** Точка центра полосы: dirSign 1 — движение a→b, -1 — b→a;
   * along — метры от центра узла a. */
  lanePoint(edgeId: number, dirSign: number, along: number): Vec2 {
    const e = this.edges[edgeId];
    const a = this.nodes[e.a];
    const u = this.edgeUnit(edgeId);
    const r = rightOf(u);
    return {
      x: a.x + u.x * along + r.x * LANE_OFF * dirSign,
      y: a.y + u.y * along + r.y * LANE_OFF * dirSign,
    };
  }

  /** Разрешённые направления движения по ребру. */
  allowedDirSigns(edgeId: number): number[] {
    return this.edges[edgeId].oneWay ? [1] : [1, -1];
  }

  /** Ближайшая полоса к точке (в пределах полотна ±6 м). */
  nearestLane(p: Vec2): LanePos | null {
    let best: LanePos | null = null;
    let bestScore = Infinity;
    for (let id = 0; id < this.edges.length; id++) {
      const e = this.edges[id];
      const a = this.nodes[e.a];
      const u = this.edgeUnit(id);
      const len = this.edgeLen(id);
      const dx = p.x - a.x;
      const dy = p.y - a.y;
      const along = dx * u.x + dy * u.y;
      if (along < 0 || along > len) continue;
      const r = rightOf(u);
      const lateral = dx * r.x + dy * r.y;
      if (Math.abs(lateral) > HALF_ROAD + 1.5) continue;
      if (Math.abs(lateral) < bestScore) {
        bestScore = Math.abs(lateral);
        const dirSign = e.oneWay ? 1 : lateral >= 0 ? 1 : -1;
        best = { edge: id, dirSign, along, lateral };
      }
    }
    return best;
  }

  /** Расстояние вдоль подъезда до стоп-линии узла (>0 — не доехал). */
  distToStopLine(nodeId: number, edgeId: number, p: Vec2): number {
    const n = this.nodes[nodeId];
    const u = this.edgeUnit(edgeId);
    const e = this.edges[edgeId];
    // движение к узлу: от дальнего конца ребра к n
    const sign = e.a === nodeId ? -1 : 1;
    const toNode = { x: u.x * sign, y: u.y * sign };
    const distToCenter = (n.x - p.x) * toNode.x + (n.y - p.y) * toNode.y;
    return distToCenter - HALF_ROAD - STOP_LINE_OFFSET;
  }

  /** Точки проезда узла с полосы въезда (inEdge) на полосу выезда (outEdge):
   * прямой — отрезок, поворот — дуга, касательная к осям полос.
   * Первая/последняя точки могут лежать чуть за квадратом узла (на полосах). */
  turnPath(nodeId: number, inEdgeId: number, outEdgeId: number): Vec2[] {
    const n = this.nodes[nodeId];
    const inSide = this.approachSide(nodeId, inEdgeId);
    const outSide = this.approachSide(nodeId, outEdgeId);
    const f = DIR_VEC[opposite(inSide)]; // направление движения внутрь узла
    const o = DIR_VEC[outSide];          // направление движения наружу
    const rf = rightOf(f);
    const ro = rightOf(o);
    const entry: Vec2 = {
      x: n.x - f.x * HALF_ROAD + rf.x * LANE_OFF,
      y: n.y - f.y * HALF_ROAD + rf.y * LANE_OFF,
    };
    const exit: Vec2 = {
      x: n.x + o.x * HALF_ROAD + ro.x * LANE_OFF,
      y: n.y + o.y * HALF_ROAD + ro.y * LANE_OFF,
    };
    if (inSide === opposite(outSide)) {
      return [entry, exit];
    }
    if (inSide === outSide) {
      // разворот в тупике: полукруг между полосами
      return this.deadEndLoop(nodeId, inEdgeId);
    }
    const cross = f.x * o.y - f.y * o.x;
    const sgn = cross > 0 ? 1 : -1; // >0 — правый поворот
    const R = sgn > 0 ? 4.5 : 5.5;
    // центр дуги — пересечение осей полос, смещённых на R в сторону поворота
    const c = lineIntersect(
      { x: entry.x + rf.x * R * sgn, y: entry.y + rf.y * R * sgn },
      f,
      { x: exit.x + ro.x * R * sgn, y: exit.y + ro.y * R * sgn },
      o,
    );
    const tA: Vec2 = { x: c.x - rf.x * R * sgn, y: c.y - rf.y * R * sgn };
    const tD: Vec2 = { x: c.x - ro.x * R * sgn, y: c.y - ro.y * R * sgn };
    const a0 = Math.atan2(tA.y - c.y, tA.x - c.x);
    let a1 = Math.atan2(tD.y - c.y, tD.x - c.x);
    if (sgn > 0) while (a1 < a0) a1 += 2 * Math.PI;
    else while (a1 > a0) a1 -= 2 * Math.PI;
    const pts: Vec2[] = [tA];
    for (let i = 1; i <= 8; i++) {
      const phi = a0 + ((a1 - a0) * i) / 8;
      pts.push({ x: c.x + R * Math.cos(phi), y: c.y + R * Math.sin(phi) });
    }
    return pts;
  }

  /** Разворот в тупике: подъезд по своей полосе, полукруг, выезд по встречной. */
  deadEndLoop(nodeId: number, edgeId: number): Vec2[] {
    const n = this.nodes[nodeId];
    const side = this.approachSide(nodeId, edgeId);
    const f = DIR_VEC[opposite(side)]; // движение внутрь тупика
    const rf = rightOf(f);
    const pts: Vec2[] = [];
    // от границы квадрата к центру и полукругом на встречную полосу
    pts.push({ x: n.x - f.x * HALF_ROAD + rf.x * LANE_OFF, y: n.y - f.y * HALF_ROAD + rf.y * LANE_OFF });
    const cx = n.x;
    const cy = n.y;
    const a0 = Math.atan2(rf.y, rf.x);
    for (let i = 0; i <= 8; i++) {
      // полукруг радиуса LANE_OFF против стороны поворота (налево через центр)
      const phi = a0 - (Math.PI * i) / 8;
      pts.push({ x: cx + LANE_OFF * Math.cos(phi) + f.x * LANE_OFF, y: cy + LANE_OFF * Math.sin(phi) + f.y * LANE_OFF });
    }
    pts.push({ x: n.x - f.x * HALF_ROAD - rf.x * LANE_OFF, y: n.y - f.y * HALF_ROAD - rf.y * LANE_OFF });
    return pts;
  }

  /** Сигнал светофора для подъезда со стороны side в момент t (сек);
   * null — узел не светофорный. */
  lightState(nodeId: number, side: Dir, t: number): LightState | null {
    const n = this.nodes[nodeId];
    if (n.control !== 'lights') return null;
    const tt = ((t + (n.lightOffset ?? 0)) % LIGHT_CYCLE + LIGHT_CYCLE) % LIGHT_CYCLE;
    const vertical = side === 'N' || side === 'S';
    const local = vertical ? tt : (tt + G + Y) % LIGHT_CYCLE;
    // локальная шкала группы: [0,G) green, [G,G+Y) yellow,
    // [G+Y, CYCLE-RY) red, [CYCLE-RY, CYCLE) red-yellow
    if (local < G) return 'green';
    if (local < G + Y) return 'yellow';
    if (local < LIGHT_CYCLE - RY) return 'red';
    return 'red-yellow';
  }

  /** Сколько секунд уже горит жёлтый для подъезда (null — не жёлтый).
   * Нужно правилу «жёлтый прощается, если безопасно не остановиться». */
  yellowElapsed(nodeId: number, side: Dir, t: number): number | null {
    const n = this.nodes[nodeId];
    if (n.control !== 'lights') return null;
    const tt = ((t + (n.lightOffset ?? 0)) % LIGHT_CYCLE + LIGHT_CYCLE) % LIGHT_CYCLE;
    const vertical = side === 'N' || side === 'S';
    const local = vertical ? tt : (tt + G + Y) % LIGHT_CYCLE;
    if (local >= G && local < G + Y) return local - G;
    return null;
  }

  crosswalks(): Crosswalk[] {
    return this.crosswalkList;
  }

  /** Лимит скорости в точке, км/ч. */
  speedLimitAt(p: Vec2): number {
    const lane = this.nearestLane(p);
    if (lane !== null) {
      return this.edges[lane.edge].speedLimit ?? DEFAULT_SPEED_LIMIT;
    }
    return DEFAULT_SPEED_LIMIT;
  }

  /** Другой конец ребра. */
  otherNode(edgeId: number, nodeId: number): number {
    const e = this.edges[edgeId];
    return e.a === nodeId ? e.b : e.a;
  }

  /** Можно ли ехать по ребру ОТ узла from. */
  canTravel(edgeId: number, fromNode: number): boolean {
    const e = this.edges[edgeId];
    if (!e.oneWay) return true;
    return e.a === fromNode;
  }

  /** Кратчайший маршрут (BFS по числу рёбер) с учётом односторонних. */
  route(fromNode: number, toNode: number): Route | null {
    if (fromNode === toNode) return { nodes: [fromNode], edges: [] };
    const prev = new Map<number, { node: number; edge: number }>();
    const queue = [fromNode];
    const seen = new Set([fromNode]);
    while (queue.length > 0) {
      const cur = queue.shift();
      if (cur === undefined) break;
      for (const d of DIRS) {
        const edgeId = this.nodeEdgeMap[cur][d];
        if (edgeId === undefined) continue;
        if (!this.canTravel(edgeId, cur)) continue;
        const next = this.otherNode(edgeId, cur);
        if (seen.has(next)) continue;
        seen.add(next);
        prev.set(next, { node: cur, edge: edgeId });
        if (next === toNode) {
          const nodes = [toNode];
          const edges: number[] = [];
          let at = toNode;
          while (at !== fromNode) {
            const p = prev.get(at);
            if (!p) return null;
            edges.unshift(p.edge);
            nodes.unshift(p.node);
            at = p.node;
          }
          return { nodes, edges };
        }
        queue.push(next);
      }
    }
    return null;
  }
}

export function opposite(d: Dir): Dir {
  switch (d) {
    case 'N': return 'S';
    case 'S': return 'N';
    case 'E': return 'W';
    case 'W': return 'E';
  }
}

/** Пересечение прямых p+t·d и q+s·e. */
function lineIntersect(p: Vec2, d: Vec2, q: Vec2, e: Vec2): Vec2 {
  const denom = d.x * e.y - d.y * e.x;
  const t = ((q.x - p.x) * e.y - (q.y - p.y) * e.x) / denom;
  return { x: p.x + d.x * t, y: p.y + d.y * t };
}
