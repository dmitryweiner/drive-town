import type { Vec2 } from './Car';
import { CityMap } from './CityMap';
import { mulberry32, randInt, shuffle, type Rng } from './rng';
import { LIGHT_CYCLE } from './CityMap';
import type { CitySpec, EdgeSpec, NodeSpec, Rect } from './types';

/** Зачёт цели: центр машины ближе этого радиуса. */
export const GOAL_RADIUS = 7;
/** Минимальная удалённость цели от спавна, рёбер графа. */
export const MIN_GOAL_HOPS = 4;

/** Размер решётки города (сложность уровней одинаковая). */
const COLS = 5;
const ROWS = 4;
/** Разброс длины квартала, м. */
const BLOCK_MIN = 80;
const BLOCK_MAX = 140;
/** Доля «лишних» рёбер сверх остова (меньше — больше тупиков и Т-образных). */
const EXTRA_EDGE_P = 0.55;
/** Доля односторонних улиц. */
const ONE_WAY_P = 0.15;
/** Отступ домов от осевых линий улиц. */
const BLOCK_MARGIN = 7.5;

export interface Level {
  seed: number;
  spec: CitySpec;
  map: CityMap;
  spawn: { x: number; y: number; heading: number };
  spawnNode: number;
  goal: Vec2;
  goalNode: number;
  /** Длина кратчайшего маршрута по рёбрам, м — для расчёта par-времени. */
  routeLen: number;
}

export function generateLevel(seed: number): Level {
  const rng = mulberry32(seed);

  // нерегулярная решётка: неравномерные интервалы улиц
  const xs = accumulate(rng, COLS);
  const ys = accumulate(rng, ROWS);
  const nodes: NodeSpec[] = [];
  for (let r = 0; r < ROWS; r++) {
    for (let c = 0; c < COLS; c++) {
      nodes.push({ x: xs[c], y: ys[r] });
    }
  }
  const id = (r: number, c: number): number => r * COLS + c;

  // кандидаты — все стороны решётки (ориентация a→b: восток или юг)
  const candidates: EdgeSpec[] = [];
  for (let r = 0; r < ROWS; r++) {
    for (let c = 0; c < COLS; c++) {
      if (c + 1 < COLS) candidates.push({ a: id(r, c), b: id(r, c + 1) });
      if (r + 1 < ROWS) candidates.push({ a: id(r, c), b: id(r + 1, c) });
    }
  }

  // случайный остов (гарантия связности) + часть остальных рёбер;
  // выпавшие рёбра дают Т-образные перекрёстки, повороты и тупики
  const edges: EdgeSpec[] = [];
  const uf = new UnionFind(nodes.length);
  for (const e of shuffle(rng, [...candidates])) {
    if (uf.union(e.a, e.b)) edges.push({ ...e });
  }
  for (const e of shuffle(rng, [...candidates])) {
    if (edges.some((x) => sameEdge(x, e))) continue;
    if (rng() < EXTRA_EDGE_P) edges.push({ ...e });
  }

  // односторонние улицы — только пока город остаётся строго связным
  const oneWayCount = Math.round(edges.length * ONE_WAY_P);
  let made = 0;
  for (const i of shuffle(rng, edges.map((_, k) => k))) {
    if (made >= oneWayCount) break;
    const e = edges[i];
    if (rng() < 0.5) [e.a, e.b] = [e.b, e.a];
    e.oneWay = true;
    if (stronglyConnected(nodes.length, edges)) made++;
    else delete e.oneWay;
  }

  // регулирование перекрёстков (degree >= 3)
  const deg = new Array<number>(nodes.length).fill(0);
  const sides: Partial<Record<'N' | 'E' | 'S' | 'W', number>>[] = nodes.map(() => ({}));
  edges.forEach((e, eid) => {
    deg[e.a]++;
    deg[e.b]++;
    const a = nodes[e.a];
    const b = nodes[e.b];
    if (a.x !== b.x) {
      sides[e.a][b.x > a.x ? 'E' : 'W'] = eid;
      sides[e.b][b.x > a.x ? 'W' : 'E'] = eid;
    } else {
      sides[e.a][b.y > a.y ? 'S' : 'N'] = eid;
      sides[e.b][b.y > a.y ? 'N' : 'S'] = eid;
    }
  });
  nodes.forEach((n, i) => {
    if (deg[i] < 3) return;
    const roll = rng();
    if (roll < 0.3) {
      n.control = 'lights';
      n.lightOffset = Math.floor(rng() * LIGHT_CYCLE);
      return;
    }
    if (roll < 0.75) {
      const hThrough = sides[i].E !== undefined && sides[i].W !== undefined;
      const vThrough = sides[i].N !== undefined && sides[i].S !== undefined;
      if (!hThrough && !vThrough) return; // не бывает при degree>=3, но на всякий
      n.control = 'priority';
      n.mainAxis = hThrough && vThrough ? (rng() < 0.5 ? 'h' : 'v') : hThrough ? 'h' : 'v';
      n.minorSign = rng() < 0.4 ? 'stop' : 'yield';
      return;
    }
    n.control = 'none';
  });

  // зебры в глубине длинных рёбер + зоны 30 км/ч
  for (const e of edges) {
    const len = Math.hypot(nodes[e.b].x - nodes[e.a].x, nodes[e.b].y - nodes[e.a].y);
    if (len >= 60 && rng() < 0.35) {
      e.crosswalks = [randInt(rng, 20, Math.floor(len - 20))];
      if (rng() < 0.6) e.speedLimit = 30;
    } else if (rng() < 0.08) {
      e.speedLimit = 30;
    }
  }

  // дома в кварталах
  const buildings: Rect[] = [];
  for (let r = 0; r + 1 < ROWS; r++) {
    for (let c = 0; c + 1 < COLS; c++) {
      const area: Rect = {
        xMin: xs[c] + BLOCK_MARGIN,
        xMax: xs[c + 1] - BLOCK_MARGIN,
        yMin: ys[r] + BLOCK_MARGIN,
        yMax: ys[r + 1] - BLOCK_MARGIN,
      };
      buildings.push(...blockBuildings(rng, area));
    }
  }

  const spec: CitySpec = { nodes, edges, buildings };
  const map = new CityMap(spec);

  // спавн и цель: достаточно далёкие узлы со взаимной достижимостью
  const { spawnNode, goalNode } = pickSpawnGoal(rng, map);
  const route = map.route(spawnNode, goalNode);
  if (!route || route.edges.length === 0) throw new Error('маршрут спавн→цель не найден');
  // спавн — середина ПЕРВОГО ребра маршрута, курсом от spawnNode:
  // маршрут никогда не требует разворота
  const spawn = spawnPose(map, spawnNode, route.edges[0]);
  // цель — не на ребре прибытия (иначе нужен разворот) и выезд на неё легален
  const arriveEdge = route.edges[route.edges.length - 1];
  const { goal, extraLen } = goalPoint(rng, map, goalNode, arriveEdge);
  let routeLen = extraLen - map.edgeLen(route.edges[0]) / 2;
  for (const eid of route.edges) routeLen += map.edgeLen(eid);

  return { seed, spec, map, spawn, spawnNode, goal, goalNode, routeLen };
}

function accumulate(rng: Rng, n: number): number[] {
  const out = [0];
  for (let i = 1; i < n; i++) {
    out.push(out[i - 1] + BLOCK_MIN + rng() * (BLOCK_MAX - BLOCK_MIN));
  }
  return out;
}

function sameEdge(a: EdgeSpec, b: EdgeSpec): boolean {
  return (a.a === b.a && a.b === b.b) || (a.a === b.b && a.b === b.a);
}

function stronglyConnected(n: number, edges: EdgeSpec[]): boolean {
  const fwd: number[][] = Array.from({ length: n }, () => []);
  const back: number[][] = Array.from({ length: n }, () => []);
  for (const e of edges) {
    fwd[e.a].push(e.b);
    back[e.b].push(e.a);
    if (!e.oneWay) {
      fwd[e.b].push(e.a);
      back[e.a].push(e.b);
    }
  }
  return bfsCount(fwd, 0) === n && bfsCount(back, 0) === n;
}

function bfsCount(adj: number[][], start: number): number {
  const seen = new Set([start]);
  const q = [start];
  while (q.length > 0) {
    const cur = q.pop();
    if (cur === undefined) break;
    for (const nx of adj[cur]) {
      if (!seen.has(nx)) {
        seen.add(nx);
        q.push(nx);
      }
    }
  }
  return seen.size;
}

/** 1–2 дома в квартале со случайным отступом от границ. */
function blockBuildings(rng: Rng, area: Rect): Rect[] {
  const w = area.xMax - area.xMin;
  const h = area.yMax - area.yMin;
  if (w < 14 || h < 14) return [];
  const inset = (): Rect => ({
    xMin: area.xMin + rng() * (w * 0.15),
    xMax: area.xMax - rng() * (w * 0.15),
    yMin: area.yMin + rng() * (h * 0.15),
    yMax: area.yMax - rng() * (h * 0.15),
  });
  const base = inset();
  if (w > 60 && rng() < 0.5) {
    // два дома с проулком
    const cut = base.xMin + (0.35 + rng() * 0.3) * (base.xMax - base.xMin);
    return [
      { ...base, xMax: cut - 3 },
      { ...base, xMin: cut + 3 },
    ];
  }
  return [base];
}

class UnionFind {
  private readonly p: number[];
  constructor(n: number) {
    this.p = Array.from({ length: n }, (_, i) => i);
  }
  find(x: number): number {
    while (this.p[x] !== x) {
      this.p[x] = this.p[this.p[x]];
      x = this.p[x];
    }
    return x;
  }
  union(a: number, b: number): boolean {
    const ra = this.find(a);
    const rb = this.find(b);
    if (ra === rb) return false;
    this.p[ra] = rb;
    return true;
  }
}

function pickSpawnGoal(rng: Rng, map: CityMap): { spawnNode: number; goalNode: number } {
  const ids = shuffle(rng, map.nodes.map((_, i) => i));
  let best: { spawnNode: number; goalNode: number; hops: number } | null = null;
  for (const s of ids) {
    for (const g of ids) {
      if (s === g) continue;
      const r = map.route(s, g);
      if (!r) continue;
      const hops = r.edges.length;
      if (hops >= MIN_GOAL_HOPS) return { spawnNode: s, goalNode: g };
      if (!best || hops > best.hops) best = { spawnNode: s, goalNode: g, hops };
    }
  }
  if (!best) throw new Error('город несвязный: нет пары спавн/цель');
  return best;
}

/** Спавн: середина ребра edgeId, в правой полосе, курсом ОТ узла fromNode. */
function spawnPose(map: CityMap, fromNode: number, edgeId: number): { x: number; y: number; heading: number } {
  const e = map.edges[edgeId];
  const dirSign = e.a === fromNode ? 1 : -1;
  const len = map.edgeLen(edgeId);
  const p = map.lanePoint(edgeId, dirSign, len / 2);
  const u = map.edgeUnit(edgeId);
  const heading = Math.atan2(u.y * dirSign, u.x * dirSign);
  return { x: p.x, y: p.y, heading };
}

/** Цель: осевая точка в глубине ребра, на которое можно ЛЕГАЛЬНО выехать
 * из goalNode (не односторонка навстречу и не ребро прибытия). */
function goalPoint(
  rng: Rng,
  map: CityMap,
  goalNode: number,
  arriveEdge: number,
): { goal: Vec2; extraLen: number } {
  const dirs = shuffle(rng, ['N', 'E', 'S', 'W'].slice());
  for (const d of dirs) {
    if (d !== 'N' && d !== 'E' && d !== 'S' && d !== 'W') continue;
    const eid = map.nodeEdges(goalNode)[d];
    if (eid === undefined) continue;
    if (eid === arriveEdge) continue;
    if (!map.canTravel(eid, goalNode)) continue;
    const e = map.edges[eid];
    const a = map.nodes[e.a];
    const u = map.edgeUnit(eid);
    const len = map.edgeLen(eid);
    const at = len / 2;
    return { goal: { x: a.x + u.x * at, y: a.y + u.y * at }, extraLen: len / 2 };
  }
  // fallback: центр узла (в радиус зачёта попадают с любого подъезда)
  const n = map.nodes[goalNode];
  return { goal: { x: n.x, y: n.y }, extraLen: 0 };
}
