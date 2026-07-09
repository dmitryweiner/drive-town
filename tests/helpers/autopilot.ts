import type { CarInput, Vec2 } from '../../src/game/Car';
import { CityMap, HALF_ROAD } from '../../src/game/CityMap';
import type { Level } from '../../src/game/generate';
import { approachOf, type ActorView } from '../../src/game/Rules';
import type { Round } from '../../src/game/Round';
import { clearToEnter, turnKindOf, type TurnKind } from '../../src/game/Traffic';
import { CROSSWALK_LEN } from '../../src/game/CityMap';

const CRUISE = 8;
const TURN_SPEED = 3;
const BRAKE_DECEL = 8;

interface NodePlan {
  inEdge: number;
  outEdge: number;
  turn: TurnKind;
}

/** «Идеальный водитель»: ведёт машину по кратчайшему маршруту к цели,
 * соблюдая светофоры, знаки, приоритеты, зебры и дистанцию.
 * Используется тестом разрешимости сгенерированных уровней. */
export class Autopilot {
  private readonly map: CityMap;
  private readonly path: Vec2[];
  private readonly cum: number[];
  private readonly nodePlans = new Map<number, NodePlan>();
  private readonly didStop = new Set<number>();
  private s = 0;

  constructor(private readonly round: Round) {
    this.map = round.plan.map;
    this.path = this.buildPath(round.plan);
    this.cum = [0];
    for (let i = 1; i < this.path.length; i++) {
      this.cum.push(this.cum[i - 1] + dist(this.path[i - 1], this.path[i]));
    }
  }

  /** Полилиния: полосы рёбер маршрута + дуги поворотов + подъезд к цели. */
  private buildPath(plan: Level): Vec2[] {
    const map = plan.map;
    const route = map.route(plan.spawnNode, plan.goalNode);
    if (!route) throw new Error('маршрут до цели не найден');

    // спавн — на первом ребре маршрута, курсом от spawnNode (см. generate)
    const spawnLane = map.nearestLane({ x: plan.spawn.x, y: plan.spawn.y });
    if (!spawnLane) throw new Error('спавн вне дороги');
    const spawnEdge = route.edges[0];
    const spawnDirSign = map.edges[spawnEdge].a === plan.spawnNode ? 1 : -1;

    // последовательность манёвров: (ребро, узел) → следующее ребро;
    // nodes[0] = spawnNode уже позади, начинаем с nodes[1]
    const hops: { edge: number; dirSign: number; node: number; nextEdge: number }[] = [];
    let curEdge = spawnEdge;
    let curDirSign = spawnDirSign;
    for (let i = 1; i < route.nodes.length; i++) {
      const node = route.nodes[i];
      const nextEdge = i < route.edges.length ? route.edges[i] : this.goalEdge(plan, curEdge);
      if (nextEdge === -1) break;
      hops.push({ edge: curEdge, dirSign: curDirSign, node, nextEdge });
      curDirSign = map.edges[nextEdge].a === node ? 1 : -1;
      curEdge = nextEdge;
    }

    const pts: Vec2[] = [{ x: plan.spawn.x, y: plan.spawn.y }];
    let along = spawnLane.along;
    let edge = spawnEdge;
    let dirSign = spawnDirSign;
    for (const hop of hops) {
      const turnPts =
        hop.nextEdge === hop.edge
          ? map.deadEndLoop(hop.node, hop.edge)
          : map.turnPath(hop.node, hop.edge, hop.nextEdge);
      this.nodePlans.set(hop.node, {
        inEdge: hop.edge,
        outEdge: hop.nextEdge,
        turn: turnKindOf(map, hop.node, hop.edge, hop.nextEdge),
      });
      // прямой участок до начала дуги
      const alongTA = this.alongOf(hop.edge, turnPts[0]);
      pts.push(map.lanePoint(hop.edge, dirSign, mid(along, alongTA, dirSign)));
      pts.push(...turnPts);
      edge = hop.nextEdge;
      dirSign = map.edges[edge].a === hop.node ? 1 : -1;
      along = this.alongOf(edge, turnPts[turnPts.length - 1]);
    }
    // финальный участок до цели
    const goalLane = this.map.nearestLane(plan.goal);
    if (goalLane && goalLane.edge === edge) {
      pts.push(this.map.lanePoint(edge, dirSign, goalLane.along));
    } else {
      pts.push(plan.goal);
    }
    return pts;
  }

  /** Ребро, на котором лежит цель (−1 — цель в центре узла). */
  private goalEdge(plan: Level, arriveEdge: number): number {
    const lane = this.map.nearestLane(plan.goal);
    if (!lane || lane.edge === arriveEdge) return -1;
    return lane.edge;
  }

  private alongOf(edge: number, p: Vec2): number {
    const a = this.map.nodes[this.map.edges[edge].a];
    const u = this.map.edgeUnit(edge);
    return (p.x - a.x) * u.x + (p.y - a.y) * u.y;
  }

  private pointAt(s: number): Vec2 {
    const cl = Math.max(0, Math.min(s, this.cum[this.cum.length - 1]));
    for (let i = 1; i < this.path.length; i++) {
      if (this.cum[i] >= cl) {
        const segLen = this.cum[i] - this.cum[i - 1];
        const t = segLen > 0 ? (cl - this.cum[i - 1]) / segLen : 0;
        return {
          x: this.path[i - 1].x + (this.path[i].x - this.path[i - 1].x) * t,
          y: this.path[i - 1].y + (this.path[i].y - this.path[i - 1].y) * t,
        };
      }
    }
    return this.path[this.path.length - 1];
  }

  private advanceProgress(pos: Vec2): void {
    let best = this.s;
    let bestD = Infinity;
    for (let i = 1; i < this.path.length; i++) {
      if (this.cum[i] < this.s - 1) continue;
      if (this.cum[i - 1] > this.s + 12) break;
      const a = this.path[i - 1];
      const b = this.path[i];
      const len = this.cum[i] - this.cum[i - 1];
      if (len === 0) continue;
      const t = clamp(((pos.x - a.x) * (b.x - a.x) + (pos.y - a.y) * (b.y - a.y)) / (len * len), 0, 1);
      const px = a.x + (b.x - a.x) * t;
      const py = a.y + (b.y - a.y) * t;
      const d = Math.hypot(pos.x - px, pos.y - py);
      const sHere = this.cum[i - 1] + len * t;
      if (d < bestD && sHere >= this.s - 0.5) {
        bestD = d;
        best = sHere;
      }
    }
    this.s = Math.max(this.s, best);
  }

  update(): CarInput {
    const car = this.round.car;
    const pos = car.position;
    const v = car.velocity;
    const heading = car.heading;

    this.advanceProgress(pos);
    const lookahead = Math.max(3, v * 0.55);
    const target = this.pointAt(this.s + lookahead);
    const desired = Math.atan2(target.y - pos.y, target.x - pos.x);
    const dh = angleDiff(desired, heading);
    const ld = Math.max(lookahead, dist(target, pos));
    const steerAngle = Math.atan2(2 * car.wheelBase * Math.sin(dh), ld);
    const steer = clamp(steerAngle / 0.6, -1, 1);

    let speed = Math.min(CRUISE, (this.map.speedLimitAt(pos) / 3.6) * 0.85);
    if (Math.abs(steer) > 0.45) speed = Math.min(speed, TURN_SPEED);

    // замедление перед изгибом пути
    const hNow = segHeading(this.pointAt(this.s), this.pointAt(this.s + 2));
    for (let ahead = 3; ahead <= 14; ahead += 2) {
      const p1 = this.pointAt(this.s + ahead);
      const p2 = this.pointAt(this.s + ahead + 2);
      if (dist(p1, p2) < 0.5) break;
      if (Math.abs(angleDiff(segHeading(p1, p2), hNow)) > 0.3) {
        speed = Math.min(speed, TURN_SPEED);
        break;
      }
    }

    const vehicles = this.round.traffic.vehicleViews();
    // дистанция до попутных
    for (const n of vehicles) {
      const dx = n.x - pos.x;
      const dy = n.y - pos.y;
      const fwd = dx * Math.cos(heading) + dy * Math.sin(heading);
      const lat = -dx * Math.sin(heading) + dy * Math.cos(heading);
      if (fwd > 0 && fwd < 12 && Math.abs(lat) < 2.2) {
        speed = Math.min(speed, fwd < 6 ? 0 : Math.abs(n.speed) * 0.9);
      }
    }

    // причины остановиться у стоп-линии впереди
    const holds: number[] = [];
    const view: ActorView = {
      id: -1, x: pos.x, y: pos.y, heading, speed: v, length: car.length, width: car.width,
    };
    const ap = approachOf(this.map, view) ?? this.staticApproach(pos, heading);
    if (ap && ap.d > -0.5 && ap.d < 18) {
      const node = this.map.nodes[ap.node];
      const light = this.map.lightState(ap.node, ap.side, this.round.time);
      if (light === 'red' || light === 'red-yellow') {
        holds.push(ap.d);
      } else if (light === 'yellow') {
        // стоим, если остановиться ещё безопасно; иначе завершаем проезд
        if (ap.d > (v * v) / 8 + 2) holds.push(ap.d);
      } else if (light === 'green' && ap.d > 4) {
        // к прибытию зелёный кончится — заранее плавно останавливаемся
        const eta = this.round.time + ap.d / Math.max(v, 2);
        if (this.map.lightState(ap.node, ap.side, eta) !== 'green') holds.push(ap.d);
      }
      const needStop =
        node.control === 'priority' &&
        node.minorSign === 'stop' &&
        (node.mainAxis === 'h' ? ap.side === 'N' || ap.side === 'S' : ap.side === 'E' || ap.side === 'W');
      if (needStop && !this.didStop.has(ap.node)) {
        holds.push(ap.d);
        if (Math.abs(v) < 0.08 && ap.d >= 0 && ap.d < 6) this.didStop.add(ap.node);
      }
      if (light === null || light === 'green') {
        const turn = this.nodePlans.get(ap.node)?.turn ?? 'straight';
        const needClear = !(needStop && !this.didStop.has(ap.node));
        if (needClear && ap.d < 15 && !clearToEnter(this.map, ap.node, ap.side, turn, -1, vehicles)) {
          holds.push(ap.d);
        }
      }
    }

    // зебры с пешеходами на текущем пути
    const peds = this.round.traffic.pedViews();
    this.map.crosswalks().forEach((cw, i) => {
      const cwPos = { x: (cw.rect.xMin + cw.rect.xMax) / 2, y: (cw.rect.yMin + cw.rect.yMax) / 2 };
      const dx = cwPos.x - pos.x;
      const dy = cwPos.y - pos.y;
      const fwd = dx * Math.cos(heading) + dy * Math.sin(heading);
      const lat = -dx * Math.sin(heading) + dy * Math.cos(heading);
      if (fwd < -1 || fwd > 25 || Math.abs(lat) > 3) return;
      const pedNear = peds.some((p) => p.crosswalk === i && (p.onRoad || nearRoad(p, cw.rect)));
      if (pedNear) holds.push(fwd - CROSSWALK_LEN / 2 - 0.5);
    });

    for (const h of holds) {
      if (h < 0.8) {
        speed = 0;
      } else {
        const room = Math.max(0, h - 1.5 - car.length / 2);
        speed = Math.min(speed, Math.sqrt(2 * BRAKE_DECEL * room) * 0.7);
      }
    }

    if (v > speed + 0.2) {
      return { throttle: 0, brake: clamp((v - speed) * 0.8, 0.2, 1), steer };
    }
    if (v < speed - 0.2) {
      return { throttle: clamp((speed - v) * 0.5, 0.2, 1), brake: 0, steer };
    }
    return { throttle: 0, brake: 0, steer };
  }

  /** approachOf по курсу, когда стоим (approachOf требует движения). */
  private staticApproach(pos: Vec2, heading: number) {
    const view: ActorView = {
      id: -1, x: pos.x, y: pos.y, heading, speed: 1, length: 4, width: 2,
    };
    return approachOf(this.map, view);
  }
}

/** Пешеход у кромки (в шаге от полотна) — тоже причина пропустить. */
function nearRoad(p: { x: number; y: number }, rect: { xMin: number; xMax: number; yMin: number; yMax: number }): boolean {
  const cx = (rect.xMin + rect.xMax) / 2;
  const cy = (rect.yMin + rect.yMax) / 2;
  // у зебры поперёк горизонтальной дороги полоса узкая по x и широкая по y
  const horizontalRoad = rect.xMax - rect.xMin < rect.yMax - rect.yMin;
  const across = horizontalRoad ? Math.abs(p.y - cy) : Math.abs(p.x - cx);
  return across <= HALF_ROAD + 0.8;
}

function mid(alongFrom: number, alongTo: number, dirSign: number): number {
  // не даём прямому участку «пятиться», если дуга начинается раньше текущей точки
  return dirSign > 0 ? Math.max(alongFrom, alongTo) : Math.min(alongFrom, alongTo);
}

function segHeading(a: Vec2, b: Vec2): number {
  return Math.atan2(b.y - a.y, b.x - a.x);
}

function dist(a: Vec2, b: Vec2): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

function angleDiff(a: number, b: number): number {
  let d = a - b;
  while (d > Math.PI) d -= 2 * Math.PI;
  while (d < -Math.PI) d += 2 * Math.PI;
  return d;
}

function clamp(x: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, x));
}
