import type { Vec2 } from './Car';
import {
  CityMap,
  DIR_VEC,
  HALF_ROAD,
  RAIL_HALF,
  STOP_LINE_OFFSET,
  CROSSWALK_LEN,
  dirOfVec,
  opposite,
  rightOf,
} from './CityMap';
import { approachOf, type ActorView, type PedView } from './Rules';
import { pick, type Rng } from './rng';
import type { Dir, VehicleKind } from './types';

export const KIND_SPEED: Record<VehicleKind, number> = {
  car: 9,
  motorcycle: 11,
  bicycle: 4,
};

export const KIND_SIZE: Record<VehicleKind, { length: number; width: number }> = {
  car: { length: 4, width: 2 },
  motorcycle: { length: 2.2, width: 0.9 },
  bicycle: { length: 1.8, width: 0.7 },
};

const NPC_COLORS = ['#c0392b', '#2980b9', '#27ae60', '#8e44ad', '#d35400', '#16a085', '#7f8c8d', '#f39c12'];

/** Скорость в дуге поворота. */
const TURN_SPEED = 4;
/** Разгон NPC, м/с² (торможение мгновенное — как в driving-trainer).
 * Без лимита NPC набирал 0→9 м/с за тик и «влетал» под чужие
 * tta-оценки помехи. */
const NPC_ACCEL = 3;
/** Помеха считается, если приедет к перекрёстку раньше этого времени, с. */
const CONFLICT_TTA = 4;
/** И ближе этого расстояния, м. */
const CONFLICT_DIST = 30;
/** Левый поворот/разворот — манёвр медленный (~4–5 с), встречным нужен
 * зазор больше: быстрый мотоцикл из-за 30 м успевает прилететь. */
const ONCOMING_TTA = 6;
const ONCOMING_DIST = 55;
/** Дальность слежения за впереди идущим. */
const GAP_AHEAD = 22;
const WALK_SPEED = 1.2;
/** Клаксон «блокировки»: игрок торчит в конусе стоящего NPC дольше этого, с. */
const HONK_BLOCKED_AFTER = 3;
/** База интервала повтора гудка; джиттер — из id, НЕ из rng (детерминизм). */
const HONK_REPEAT_BASE = 4;
/** «Подрезание»: требуемое замедление резче этого — гудок, м/с². */
const HONK_CUTOFF_DECEL = 4;

export interface VehicleSpec {
  kind: VehicleKind;
  edge: number;
  /** 1 — по ребру a→b, -1 — против. */
  dirSign: number;
  /** Метры от центра узла a. */
  along: number;
  color?: string;
}

export interface PedSpec {
  /** Индекс зебры в map.crosswalks(). */
  crosswalk: number;
  delay?: number;
  pause?: number;
}

interface TrafficOpts {
  vehicles: VehicleSpec[];
  peds?: PedSpec[];
}

/** Гудок раздражённого NPC — событие для звука (см. SOUND.md). */
export interface HonkEvent {
  x: number;
  y: number;
  /** blocked — стоит за игроком; cutoff — игрок подрезал. */
  kind: 'blocked' | 'cutoff';
  /** Номер гудка в серии «блокировки» (раздражение растёт), у cutoff всегда 1. */
  n: number;
}

export type TurnKind = 'left' | 'right' | 'straight' | 'uturn';

/** Тип манёвра при проезде узла с ребра inEdge на outEdge. */
export function turnKindOf(map: CityMap, node: number, inEdge: number, outEdge: number): TurnKind {
  if (inEdge === outEdge) return 'uturn';
  const inSide = map.approachSide(node, inEdge);
  const outSide = map.approachSide(node, outEdge);
  if (inSide === opposite(outSide)) return 'straight';
  const f = DIR_VEC[opposite(inSide)];
  const o = DIR_VEC[outSide];
  return f.x * o.y - f.y * o.x > 0 ? 'right' : 'left';
}

/** Свободен ли перекрёсток от тех, кому участник обязан уступить,
 * с учётом манёвра (левый поворот/разворот уступает встречным). */
export function clearToEnter(
  map: CityMap,
  node: number,
  side: Dir,
  turn: TurnKind,
  selfId: number,
  others: ActorView[],
): boolean {
  const n = map.nodes[node];
  let yieldSides: Dir[];
  if (n.control === 'lights') {
    yieldSides = []; // регулируемый: только физическая занятость + встречные при левом
  } else if (n.control === 'priority') {
    const main: Dir[] = n.mainAxis === 'h' ? ['E', 'W'] : ['N', 'S'];
    yieldSides = main.includes(side) ? [] : main;
  } else if (n.control === 'roundabout') {
    yieldSides = []; // кольцо: уступаем только тем, кто уже на нём (занятость)
  } else {
    // правило правой руки
    const travel = DIR_VEC[opposite(side)];
    yieldSides = [dirOfVec(rightOf(travel))];
  }
  // на кольце встречных нет: все едут вокруг островка в одну сторону
  const leftish = (turn === 'left' || turn === 'uturn') && n.control !== 'roundabout';
  const oncomingSide = leftish ? opposite(side) : null;
  if (oncomingSide !== null && !yieldSides.includes(oncomingSide)) {
    yieldSides = [...yieldSides, oncomingSide];
  }
  for (const o of others) {
    if (o.id === selfId) continue;
    // кто-то в зоне узла (квадрат/кольцо) — ждём
    if (map.inNodeArea(node, { x: o.x, y: o.y })) return false;
    if (yieldSides.length === 0) continue;
    if (Math.abs(o.speed) < 0.5) continue; // стоящий не помеха
    const ap = approachOf(map, o);
    if (!ap || ap.node !== node || !yieldSides.includes(ap.side)) continue;
    const tta = ap.d / Math.max(Math.abs(o.speed), 0.5);
    const [maxDist, maxTta] =
      ap.side === oncomingSide ? [ONCOMING_DIST, ONCOMING_TTA] : [CONFLICT_DIST, CONFLICT_TTA];
    if (ap.d > -2 && ap.d < maxDist && tta < maxTta) return false;
  }
  return true;
}

/** Бронь перекрёстков: в квадрате одновременно не больше одного NPC. */
class NodeArbiter {
  private holders = new Map<number, number>();

  tryAcquire(node: number, id: number): boolean {
    const h = this.holders.get(node);
    if (h === undefined || h === id) {
      this.holders.set(node, id);
      return true;
    }
    return false;
  }

  holds(node: number, id: number): boolean {
    return this.holders.get(node) === id;
  }

  release(node: number, id: number): void {
    if (this.holders.get(node) === id) this.holders.delete(node);
  }
}

interface TurnPlan {
  node: number;
  nextEdge: number;
  nextDirSign: number;
  turn: TurnKind;
  pts: Vec2[];
  cum: number[];
  total: number;
  /** Координата along текущего ребра, где начинается дуга. */
  alongTA: number;
}

class NpcVehicle {
  readonly id: number;
  readonly kind: VehicleKind;
  readonly color: string;
  pos: Vec2 = { x: 0, y: 0 };
  heading = 0;
  speed = 0;

  private mode: 'edge' | 'turn' = 'edge';
  private edge: number;
  private dirSign: number;
  private along: number;
  private plan: TurnPlan | null = null;
  private turnS = 0;
  private stopDone = false;
  /** Индекс ЖД-переезда, перед которым остановка уже выполнена. */
  private railDone: number | null = null;
  private reservedNode: number | null = null;
  /** Сколько секунд стоим с бронью, не двигаясь (страховка от гридлока). */
  private reservedIdle = 0;
  // клаксон: детекция всегда активна и без побочек для движения (SOUND.md)
  private blockedFor = 0;
  private honkRepeatIn = 0;
  private honkCount = 0;
  private playerWasInCone = false;

  constructor(id: number, spec: VehicleSpec, private readonly map: CityMap) {
    this.id = id;
    this.kind = spec.kind;
    this.color = spec.color ?? NPC_COLORS[id % NPC_COLORS.length];
    this.edge = spec.edge;
    this.dirSign = spec.dirSign;
    this.along = spec.along;
    this.syncPose();
  }

  get size(): { length: number; width: number } {
    return KIND_SIZE[this.kind];
  }

  view(): ActorView {
    return {
      id: this.id,
      x: this.pos.x,
      y: this.pos.y,
      heading: this.heading,
      speed: this.speed,
      length: this.size.length,
      width: this.size.width,
    };
  }

  step(dt: number, time: number, others: ActorView[], peds: PedView[], arbiter: NodeArbiter, rng: Rng): void {
    // бронь нужна только чтобы пересечь квадрат: отпускаем сразу после
    // проезда узла (на коротких кварталах застрявший за перекрёстком
    // холдер иначе запирает весь узел и город встаёт кольцом)
    if (this.reservedNode !== null) {
      const e = this.map.edges[this.edge];
      const target =
        this.mode === 'edge' ? (this.dirSign > 0 ? e.b : e.a) : this.plan?.node ?? -1;
      const inBox = this.inBoxOf(this.reservedNode);
      if (this.mode === 'edge' && target !== this.reservedNode && !inBox) {
        arbiter.release(this.reservedNode, this.id);
        this.reservedNode = null;
        this.reservedIdle = 0;
      } else if (!inBox && Math.abs(this.speed) < 0.2) {
        // страховка: держим бронь стоя — через 8 с уступаем её другим
        this.reservedIdle += dt;
        if (this.reservedIdle > 8) {
          arbiter.release(this.reservedNode, this.id);
          this.reservedNode = null;
          this.reservedIdle = 0;
        }
      } else {
        this.reservedIdle = 0;
      }
    }

    if (this.mode === 'turn') {
      this.stepTurn(dt, others);
      return;
    }
    this.stepEdge(dt, time, others, peds, arbiter, rng);
  }

  /** Триггеры клаксона; зовётся ДО step (для «подрезания» нужна скорость
   * до мгновенного торможения этого же тика). Движение не меняет. */
  detectHonk(dt: number, time: number, player: ActorView | null): HonkEvent | null {
    if (!player) {
      this.blockedFor = 0;
      this.honkCount = 0;
      this.playerWasInCone = false;
      return null;
    }
    const travel = { x: Math.cos(this.heading), y: Math.sin(this.heading) };
    const right = rightOf(travel);
    const rx = player.x - this.pos.x;
    const ry = player.y - this.pos.y;
    const fd = rx * travel.x + ry * travel.y;
    const lat = Math.abs(rx * right.x + ry * right.y);
    const inCone = fd > 0.5 && fd < GAP_AHEAD && lat < 2.3;

    // «подрезание»: игрок ПОЯВИЛСЯ в конусе (фронт, латч на эпизод) и
    // требуемое замедление резкое
    let honk: HonkEvent | null = null;
    if (inCone && !this.playerWasInCone && this.speed > 1) {
      const gap = fd - this.size.length / 2 - player.length / 2;
      if (gap > 0 && (this.speed * this.speed) / (2 * gap) > HONK_CUTOFF_DECEL) {
        honk = { x: this.pos.x, y: this.pos.y, kind: 'cutoff', n: 1 };
      }
    }
    this.playerWasInCone = inCone;

    // «блокировка»: стоим за игроком; на запрещающий свет очередь не гудит —
    // ждать пришлось бы и без игрока
    const blocked = inCone && Math.abs(this.speed) < 0.3 && !this.waitingAtLight(time);
    if (!blocked) {
      this.blockedFor = 0;
      this.honkCount = 0;
      this.honkRepeatIn = 0;
      return honk;
    }
    this.blockedFor += dt;
    this.honkRepeatIn -= dt;
    if (this.blockedFor >= HONK_BLOCKED_AFTER && this.honkRepeatIn <= 0) {
      this.honkCount += 1;
      this.honkRepeatIn = HONK_REPEAT_BASE + (this.id % 3);
      honk = { x: this.pos.x, y: this.pos.y, kind: 'blocked', n: this.honkCount };
    }
    return honk;
  }

  /** Свет по курсу NPC не зелёный — стоять пришлось бы и без игрока. */
  private waitingAtLight(time: number): boolean {
    if (this.mode !== 'edge') return false;
    const e = this.map.edges[this.edge];
    const node = this.dirSign > 0 ? e.b : e.a;
    const side = this.map.approachSide(node, this.edge);
    const light = this.map.lightState(node, side, time);
    return light !== null && light !== 'green';
  }

  private stepTurn(dt: number, others: ActorView[]): void {
    const plan = this.plan;
    if (!plan) {
      this.mode = 'edge';
      return;
    }
    // на кольце даже «прямо» — дуга вокруг островка
    const ringNode = this.map.nodes[plan.node].control === 'roundabout';
    const vmax = plan.turn !== 'straight' || ringNode ? TURN_SPEED : this.freeSpeed();
    const target = Math.min(vmax, this.followSpeed(others, vmax, plan));
    this.speed = Math.min(target, this.speed + NPC_ACCEL * dt);
    this.turnS += this.speed * dt;
    if (this.turnS >= plan.total) {
      // выезд на новое ребро
      this.edge = plan.nextEdge;
      this.dirSign = plan.nextDirSign;
      const a = this.map.nodes[this.map.edges[this.edge].a];
      const u = this.map.edgeUnit(this.edge);
      const last = plan.pts[plan.pts.length - 1];
      this.along = (last.x - a.x) * u.x + (last.y - a.y) * u.y;
      this.pos = { ...last };
      this.mode = 'edge';
      this.plan = null;
      this.stopDone = false;
      this.railDone = null;
      this.syncPose();
      return;
    }
    this.advanceAlongPts(plan.pts, plan.cum, this.turnS);
  }

  private stepEdge(dt: number, time: number, others: ActorView[], peds: PedView[], arbiter: NodeArbiter, rng: Rng): void {
    const len = this.map.edgeLen(this.edge);
    const e = this.map.edges[this.edge];
    const node = this.dirSign > 0 ? e.b : e.a;
    // у кольца зона узла шире квадрата — стоп-линия перед внешним краем
    const r = this.map.nodeRadius(node);
    const boundary = this.dirSign > 0 ? len - r : r;
    const dBox = (boundary - this.along) * this.dirSign;
    const dStopLine = dBox - STOP_LINE_OFFSET;

    if ((this.plan === null || this.plan.node !== node) && dBox < 30) {
      this.plan = this.makePlan(node, rng);
    }

    // можно ли ехать в перекрёсток
    let allowed = false;
    if (this.plan) {
      if (dStopLine > 20) {
        allowed = true; // далеко — просто едем
      } else {
        const side = this.map.approachSide(node, this.edge);
        // полная остановка перед знаком «стоп»
        const n = this.map.nodes[node];
        const needStop =
          n.control === 'priority' && n.minorSign === 'stop' && this.isMinorSide(node, side);
        if (needStop && dStopLine < 3 && Math.abs(this.speed) < 0.08) this.stopDone = true;
        const controlOk = this.controlOk(node, side, time, needStop);
        const clear = controlOk && clearToEnter(this.map, node, side, this.plan.turn, this.id, others);
        // бронь берёт только первый в очереди, иначе задний захватит её
        // и колонна встанет намертво
        const firstInLine = !this.blockedAhead(others, dStopLine);
        if (clear && firstInLine && arbiter.tryAcquire(node, this.id)) {
          this.reservedNode = node;
          allowed = true;
        }
      }
    }

    // кандидаты остановки: сколько ещё может проехать центр
    const candidates: number[] = [];
    if (!allowed || this.plan === null) {
      candidates.push(dStopLine - this.size.length / 2);
    }
    const cwStop = this.crosswalkStop(peds);
    if (cwStop !== null) candidates.push(cwStop);
    const railStop = this.railwayStop();
    if (railStop !== null) candidates.push(railStop);

    const vmax = this.freeSpeed();
    let target = Math.min(vmax, this.followSpeed(others, vmax));
    for (const d of candidates) {
      target = Math.min(target, stopProfile(d, vmax));
    }
    this.speed = Math.min(target, this.speed + NPC_ACCEL * dt);
    this.along += this.speed * dt * this.dirSign;

    // переход в дугу поворота
    if (allowed && this.plan) {
      const dTA = (this.plan.alongTA - this.along) * this.dirSign;
      if (dTA <= 0) {
        this.mode = 'turn';
        this.turnS = this.projectOnPts(this.plan.pts, this.plan.cum);
        return;
      }
    }
    this.syncPose();
  }

  /** Максимум по виду ТС и лимиту ребра. */
  private freeSpeed(): number {
    const limit = (this.map.edges[this.edge].speedLimit ?? 50) / 3.6;
    return Math.min(KIND_SPEED[this.kind], limit);
  }

  private inBoxOf(nodeId: number): boolean {
    return this.map.inNodeArea(nodeId, this.pos);
  }

  /** Есть ли кто-то попутный между мной и стоп-линией. */
  private blockedAhead(others: ActorView[], dStopLine: number): boolean {
    const travel = { x: Math.cos(this.heading), y: Math.sin(this.heading) };
    const right = rightOf(travel);
    for (const o of others) {
      if (o.id === this.id) continue;
      const rx = o.x - this.pos.x;
      const ry = o.y - this.pos.y;
      const fd = rx * travel.x + ry * travel.y;
      const lat = Math.abs(rx * right.x + ry * right.y);
      if (fd > 0.5 && fd < dStopLine + 2 && lat < 2.3) return true;
    }
    return false;
  }

  /** Скорость, не таранящая впереди идущего (включая игрока).
   * В дуге поворота (plan задан) стоящий В СТОРОНЕ от траектории — не
   * помеха: он ждёт нас у своей стоп-линии, а нос в дуге временно
   * смотрит на него (иначе взаимное «после вас» и гридлок). */
  private followSpeed(others: ActorView[], vmax: number, plan: TurnPlan | null = null): number {
    const travel = { x: Math.cos(this.heading), y: Math.sin(this.heading) };
    const right = rightOf(travel);
    let v = vmax;
    for (const o of others) {
      if (o.id === this.id) continue;
      const rx = o.x - this.pos.x;
      const ry = o.y - this.pos.y;
      const fd = rx * travel.x + ry * travel.y;
      const lat = Math.abs(rx * right.x + ry * right.y);
      if (fd <= 0 || fd > GAP_AHEAD || lat > 2.3) continue;
      if (plan && Math.abs(o.speed) < 0.5 && this.distToTurnAhead(plan, o) > 2.6) continue;
      const d = fd - this.size.length / 2 - o.length / 2 - 1.5;
      v = Math.min(v, stopProfile(d, vmax));
    }
    return v;
  }

  /** Расстояние от актора до остатка дуги поворота. */
  private distToTurnAhead(plan: TurnPlan, o: ActorView): number {
    let best = Infinity;
    for (let i = 1; i < plan.pts.length; i++) {
      if (plan.cum[i] < this.turnS - 1) continue;
      const a = plan.pts[i - 1];
      const b = plan.pts[i];
      const abx = b.x - a.x;
      const aby = b.y - a.y;
      const ab2 = abx * abx + aby * aby;
      const t = ab2 > 0 ? Math.max(0, Math.min(1, ((o.x - a.x) * abx + (o.y - a.y) * aby) / ab2)) : 0;
      best = Math.min(best, Math.hypot(o.x - (a.x + abx * t), o.y - (a.y + aby * t)));
    }
    return best;
  }

  /** Остановка перед ЖД-переездом: обязательная полная, затем проезд. */
  private railwayStop(): number | null {
    let best: { i: number; d: number } | null = null;
    this.map.railways().forEach((rw, i) => {
      if (rw.edge !== this.edge) return;
      // d — от центра машины до стоп-линии (за 1 м до полотна рельсов)
      const d = (rw.at - this.along) * this.dirSign - RAIL_HALF - STOP_LINE_OFFSET;
      if (d < -1) return; // уже на переезде/за ним
      if (!best || d < best.d) best = { i, d };
    });
    if (!best) {
      this.railDone = null;
      return null;
    }
    const { i, d } = best;
    if (this.railDone === i) return null;
    if (d < 3 && Math.abs(this.speed) < 0.08) {
      this.railDone = i;
      return null;
    }
    return d - this.size.length / 2;
  }

  /** Остановка перед зеброй, если на ней пешеход. */
  private crosswalkStop(peds: PedView[]): number | null {
    let best: number | null = null;
    this.map.crosswalks().forEach((cw, i) => {
      if (cw.edge !== this.edge) return;
      const dCw = (cw.at - this.along) * this.dirSign - CROSSWALK_LEN / 2;
      if (dCw < -1) return; // уже на зебре/за ней — не тормозим поперёк
      const pedOn = peds.some((p) => p.crosswalk === i && p.onRoad);
      if (!pedOn) return;
      const d = dCw - this.size.length / 2 - 0.3;
      best = best === null ? d : Math.min(best, d);
    });
    return best;
  }

  private makePlan(node: number, rng: Rng): TurnPlan | null {
    const edgesAt = this.map.nodeEdges(node);
    const options: number[] = [];
    for (const d of ['N', 'E', 'S', 'W'] as const) {
      const eid = edgesAt[d];
      if (eid === undefined || eid === this.edge) continue;
      if (!this.map.canTravel(eid, node)) continue;
      options.push(eid);
    }
    let nextEdge: number;
    let pts: Vec2[];
    if (options.length === 0) {
      // тупик: разворот, если по своему ребру можно обратно
      if (!this.map.canTravel(this.edge, node)) return null;
      nextEdge = this.edge;
      pts = this.map.deadEndLoop(node, this.edge);
    } else {
      nextEdge = pick(rng, options);
      pts = this.map.turnPath(node, this.edge, nextEdge);
    }
    const nextDirSign = this.map.edges[nextEdge].a === node ? 1 : -1;
    const a = this.map.nodes[this.map.edges[this.edge].a];
    const u = this.map.edgeUnit(this.edge);
    const alongTA = (pts[0].x - a.x) * u.x + (pts[0].y - a.y) * u.y;
    const cum = [0];
    for (let i = 1; i < pts.length; i++) {
      cum.push(cum[i - 1] + Math.hypot(pts[i].x - pts[i - 1].x, pts[i].y - pts[i - 1].y));
    }
    const turn = turnKindOf(this.map, node, this.edge, nextEdge);
    return { node, nextEdge, nextDirSign, turn, pts, cum, total: cum[cum.length - 1], alongTA };
  }

  private isMinorSide(node: number, side: Dir): boolean {
    const n = this.map.nodes[node];
    if (n.control !== 'priority') return false;
    const main: Dir[] = n.mainAxis === 'h' ? ['E', 'W'] : ['N', 'S'];
    return !main.includes(side);
  }

  private controlOk(node: number, side: Dir, time: number, needStop: boolean): boolean {
    const light = this.map.lightState(node, side, time);
    if (light !== null) return light === 'green';
    if (needStop && !this.stopDone) return false;
    return true;
  }

  private syncPose(): void {
    const u = this.map.edgeUnit(this.edge);
    this.pos = this.map.lanePoint(this.edge, this.dirSign, this.along);
    this.heading = Math.atan2(u.y * this.dirSign, u.x * this.dirSign);
  }

  private advanceAlongPts(pts: Vec2[], cum: number[], s: number): void {
    for (let i = 1; i < pts.length; i++) {
      if (cum[i] >= s || i === pts.length - 1) {
        const segLen = cum[i] - cum[i - 1];
        const t = segLen > 0 ? Math.min(1, (s - cum[i - 1]) / segLen) : 0;
        const a = pts[i - 1];
        const b = pts[i];
        this.pos = { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t };
        if (segLen > 0.01) this.heading = Math.atan2(b.y - a.y, b.x - a.x);
        return;
      }
    }
  }

  /** Длина дуги до точки полилинии, ближайшей к текущей позиции. */
  private projectOnPts(pts: Vec2[], cum: number[]): number {
    let bestS = 0;
    let bestD = Infinity;
    for (let i = 1; i < pts.length; i++) {
      const a = pts[i - 1];
      const b = pts[i];
      const abx = b.x - a.x;
      const aby = b.y - a.y;
      const ab2 = abx * abx + aby * aby;
      const t = ab2 > 0
        ? Math.max(0, Math.min(1, ((this.pos.x - a.x) * abx + (this.pos.y - a.y) * aby) / ab2))
        : 0;
      const px = a.x + abx * t;
      const py = a.y + aby * t;
      const d = Math.hypot(this.pos.x - px, this.pos.y - py);
      if (d < bestD) {
        bestD = d;
        bestS = cum[i - 1] + Math.sqrt(ab2) * t;
      }
    }
    return bestS;
  }
}

/** Пешеход курсирует по зебре туда-обратно с паузами (из driving-trainer). */
class NpcPed {
  pos: Vec2;
  private from: Vec2;
  private to: Vec2;
  private t = 0;
  private delay: number;
  private waitLeft = 0;
  private readonly pause: number;

  constructor(readonly crosswalk: number, map: CityMap, spec: PedSpec) {
    const cw = map.crosswalks()[spec.crosswalk];
    const cx = (cw.rect.xMin + cw.rect.xMax) / 2;
    const cy = (cw.rect.yMin + cw.rect.yMax) / 2;
    const off = HALF_ROAD + 1.2;
    if (cw.axis === 'x') {
      // дорога горизонтальна — пешеход идёт по вертикали
      this.from = { x: cx, y: cy - off };
      this.to = { x: cx, y: cy + off };
    } else {
      this.from = { x: cx - off, y: cy };
      this.to = { x: cx + off, y: cy };
    }
    this.roadCenter = { x: cx, y: cy };
    this.axis = cw.axis;
    this.pos = { ...this.from };
    this.delay = spec.delay ?? 0;
    this.pause = spec.pause ?? 3.4;
  }

  private readonly roadCenter: Vec2;
  private readonly axis: 'x' | 'y';

  get onRoad(): boolean {
    const c = this.axis === 'x' ? this.pos.y - this.roadCenter.y : this.pos.x - this.roadCenter.x;
    return Math.abs(c) <= HALF_ROAD;
  }

  /** Идёт (не пауза/задержка) и ещё не дошёл до полотна. */
  get approaching(): boolean {
    if (this.delay > 0 || this.waitLeft > 0 || this.t >= 1) return false;
    if (this.onRoad) return false;
    // до дороги, а не после: доля пути до кромки полотна
    const total = Math.hypot(this.to.x - this.from.x, this.to.y - this.from.y);
    return this.t < 1.2 / total + 1e-9;
  }

  view(): PedView {
    return {
      x: this.pos.x,
      y: this.pos.y,
      onRoad: this.onRoad,
      approaching: this.approaching,
      crosswalk: this.crosswalk,
    };
  }

  update(dt: number): void {
    if (this.delay > 0) {
      this.delay -= dt;
      return;
    }
    if (this.waitLeft > 0) {
      this.waitLeft -= dt;
      if (this.waitLeft <= 0) {
        [this.from, this.to] = [this.to, this.from];
        this.t = 0;
      }
      return;
    }
    const total = Math.hypot(this.to.x - this.from.x, this.to.y - this.from.y);
    this.t += (WALK_SPEED * dt) / total;
    if (this.t >= 1) {
      this.t = 1;
      this.waitLeft = this.pause;
    }
    this.pos = {
      x: this.from.x + (this.to.x - this.from.x) * this.t,
      y: this.from.y + (this.to.y - this.from.y) * this.t,
    };
  }
}

export class Traffic {
  private readonly vehicles: NpcVehicle[];
  private readonly peds: NpcPed[];
  private readonly arbiter = new NodeArbiter();
  private pendingHonks: HonkEvent[] = [];

  constructor(map: CityMap, private readonly rng: Rng, opts: TrafficOpts) {
    this.vehicles = opts.vehicles.map((s, i) => new NpcVehicle(i, s, map));
    this.peds = (opts.peds ?? []).map((s) => new NpcPed(s.crosswalk, map, s));
  }

  /** Случайный трафик уровня: count машин + пешеходы на каждой зебре. */
  static random(map: CityMap, rng: Rng, count: number, avoid: Vec2[]): Traffic {
    const specs: VehicleSpec[] = [];
    const taken: Vec2[] = [...avoid];
    let guard = 0;
    while (specs.length < count && guard++ < count * 50) {
      const edge = Math.floor(rng() * map.edges.length);
      const len = map.edgeLen(edge);
      if (len < HALF_ROAD * 2 + 16) continue;
      const along = HALF_ROAD + 6 + rng() * (len - 2 * HALF_ROAD - 12);
      const dirSign = pick(rng, map.allowedDirSigns(edge));
      const p = map.lanePoint(edge, dirSign, along);
      if (taken.some((q) => Math.hypot(q.x - p.x, q.y - p.y) < 16)) continue;
      const roll = rng();
      const kind: VehicleKind = roll < 0.6 ? 'car' : roll < 0.8 ? 'motorcycle' : 'bicycle';
      specs.push({ kind, edge, dirSign, along });
      taken.push(p);
    }
    // по одному пешеходу на зебру с долгими паузами — иначе поток
    // почти не находит окна и трафик намертво встаёт перед переходом
    const peds: PedSpec[] = map.crosswalks().map((_, i) => ({
      crosswalk: i,
      delay: rng() * 12,
      pause: 5 + rng() * 6,
    }));
    return new Traffic(map, rng, { vehicles: specs, peds });
  }

  update(dt: number, time: number, player: ActorView | null): void {
    for (const p of this.peds) p.update(dt);
    const pedViews = this.pedViews();
    const views = this.vehicles.map((v) => v.view());
    if (player) views.push(player);
    for (const v of this.vehicles) {
      const honk = v.detectHonk(dt, time, player);
      if (honk) this.pendingHonks.push(honk);
      v.step(dt, time, views, pedViews, this.arbiter, this.rng);
    }
  }

  /** Гудки, накопленные с прошлого съёма (детекция работает всегда). */
  consumeHonks(): HonkEvent[] {
    const out = this.pendingHonks;
    this.pendingHonks = [];
    return out;
  }

  vehicleViews(): ActorView[] {
    return this.vehicles.map((v) => v.view());
  }

  vehicleColors(): string[] {
    return this.vehicles.map((v) => v.color);
  }

  vehicleKinds(): VehicleKind[] {
    return this.vehicles.map((v) => v.kind);
  }

  pedViews(): PedView[] {
    return this.peds.map((p) => p.view());
  }
}

/** Профиль торможения: стоим у цели, плавно подъезжаем (как в driving-trainer). */
function stopProfile(d: number, vmax: number): number {
  if (d <= 0.4) return 0;
  return Math.min(vmax, vmax * (d / 8));
}
