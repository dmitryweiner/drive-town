import { obbIntersect, type OBB } from './Collision';
import type { Vec2 } from './Car';
import {
  CityMap,
  DIR_VEC,
  RAIL_HALF,
  ROUNDABOUT_ISLAND_R,
  ROUNDABOUT_R,
  STOP_LINE_OFFSET,
  dirOfVec,
  opposite,
  rightOf,
} from './CityMap';
import type { Dir, Violation, ViolationType } from './types';

/** Участник движения глазами монитора правил. */
export interface ActorView {
  id: number;
  x: number;
  y: number;
  heading: number;
  /** м/с; знак — вперёд/назад относительно heading. */
  speed: number;
  length: number;
  width: number;
}

export interface PedView {
  x: number;
  y: number;
  /** Пешеход на проезжей части (не на тротуаре). */
  onRoad: boolean;
  /** Пешеход идёт и вот-вот ступит на проезжую часть. */
  approaching?: boolean;
  /** Индекс зебры в map.crosswalks(). */
  crosswalk: number;
}

/** Допуск к лимиту скорости, м/с (~3 км/ч). */
const SPEED_TOL = 0.8;
const SPEEDING_DELAY = 0.5;
const WRONG_WAY_DELAY = 0.7;
/** Короткий манёвр назад (подравняться) прощается. */
const REVERSE_DELAY = 0.7;
const OFF_ROAD_DELAY = 0.4;
/** Зона обязательной остановки перед знаком «стоп», м до линии. */
const STOP_ZONE = 10;
/** Считается полной остановкой. */
const FULL_STOP_V = 0.15;
/** NPC «приближается» к перекрёстку, если ближе этого к своей стоп-линии. */
const CONFLICT_DIST = 15;
/** ...и приедет к нему быстрее этого времени, с. */
const CONFLICT_TTA = 3.5;
/** Встречный при левом повороте учитывается ближе этого. */
const ONCOMING_DIST = 12;

export interface Approach {
  node: number;
  edge: number;
  side: Dir;
  /** Метры до стоп-линии (<0 — уже пересёк). */
  d: number;
}

/** К какому узлу движется участник по своей полосе (null — не определить). */
export function approachOf(map: CityMap, v: ActorView): Approach | null {
  const lane = map.nearestLane({ x: v.x, y: v.y });
  if (!lane) return null;
  const travel = travelDir(v);
  const u = map.edgeUnit(lane.edge);
  const dot = u.x * travel.x + u.y * travel.y;
  if (Math.abs(dot) < 0.3) return null; // едет поперёк дороги
  const sign = dot > 0 ? 1 : -1;
  const e = map.edges[lane.edge];
  const node = sign > 0 ? e.b : e.a;
  const side = map.approachSide(node, lane.edge);
  const d = map.distToStopLine(node, lane.edge, { x: v.x, y: v.y });
  return { node, edge: lane.edge, side, d };
}

export class RuleMonitor {
  private readonly map: CityMap;

  private prevApproach: Approach | null = null;
  private stopTrack: { node: number; edge: number; minSpeed: number } | null = null;
  /** Подход к ЖД-переезду: минимальная скорость в стоп-зоне и прошлый d. */
  private railTrack = new Map<number, { minSpeed: number; prevD: number }>();
  private inNode: {
    node: number;
    entrySide: Dir | null;
    /** Манёвр начался: игрок движется в квадрате, приоритет зафиксирован. */
    committed: boolean;
    oncomingSeen: boolean;
  } | null = null;
  /** Проверка полосы после поворота на односторонку (тк. 42/43 Израиля):
   * want — знак lateral нужной полосы (1 — правая, -1 — левая). */
  private laneCheck: { node: number; edge: number; want: number } | null = null;

  private speedingAcc = 0;
  private speedingLatched = false;
  private wrongWayAcc = 0;
  private wrongWayLatched = false;
  private reverseAcc = 0;
  private reverseLatched = false;
  private offRoadAcc = 0;
  private offRoadLatched = false;
  private pedPrevIn = new Map<number, boolean>();
  private vehicleContacts = new Set<number>();
  private buildingContacts = new Set<number>();

  constructor(map: CityMap) {
    this.map = map;
  }

  update(dt: number, time: number, player: ActorView, vehicles: ActorView[], peds: PedView[]): Violation[] {
    const out: Violation[] = [];
    const emit = (type: ViolationType): void => {
      out.push({ type, at: time, x: player.x, y: player.y });
    };
    const pos: Vec2 = { x: player.x, y: player.y };
    const moving = Math.abs(player.speed) > 0.3;
    const approach = this.playerApproach(player);

    // --- стоп-линия: свет и знак «стоп» ---
    if (approach && approach.d <= STOP_ZONE && approach.d > 0) {
      if (this.stopTrack && this.stopTrack.node === approach.node && this.stopTrack.edge === approach.edge) {
        this.stopTrack.minSpeed = Math.min(this.stopTrack.minSpeed, Math.abs(player.speed));
      } else {
        this.stopTrack = { node: approach.node, edge: approach.edge, minSpeed: Math.abs(player.speed) };
      }
    }
    if (
      approach &&
      this.prevApproach &&
      approach.node === this.prevApproach.node &&
      approach.edge === this.prevApproach.edge &&
      this.prevApproach.d > 0 &&
      approach.d <= 0 &&
      moving
    ) {
      const light = this.map.lightState(approach.node, approach.side, time);
      if (light === 'red' || light === 'red-yellow') {
        emit('ran-light');
      } else if (light === 'yellow') {
        // жёлтый: нарушение, только если при его включении можно было
        // безопасно остановиться (иначе разрешено завершить проезд)
        const elapsed = this.map.yellowElapsed(approach.node, approach.side, time) ?? 0;
        const v = Math.abs(player.speed);
        const distAtSwitch = elapsed * v; // где была машина при включении
        const stopDist = (v * v) / (2 * 4) + 1;
        if (distAtSwitch > stopDist) emit('ran-light');
      }
      const node = this.map.nodes[approach.node];
      if (node.control === 'priority' && node.minorSign === 'stop' && this.isMinorSide(approach.node, approach.side)) {
        const minSpeed =
          this.stopTrack && this.stopTrack.node === approach.node && this.stopTrack.edge === approach.edge
            ? this.stopTrack.minSpeed
            : Math.abs(player.speed);
        if (minSpeed > FULL_STOP_V) emit('ran-stop');
      }
      this.stopTrack = null;
    }
    if (approach && approach.d > STOP_ZONE) this.stopTrack = null;

    // --- ЖД-переезд: со знаком — обязательная полная остановка;
    // со светофором — нельзя пересекать, пока мигает красный ---
    const railLane = this.map.nearestLane(pos);
    this.map.railways().forEach((rw, i) => {
      if (!railLane || railLane.edge !== rw.edge) {
        this.railTrack.delete(i);
        return;
      }
      const travel = travelDir(player);
      const u = this.map.edgeUnit(rw.edge);
      const dot = u.x * travel.x + u.y * travel.y;
      if (Math.abs(dot) < 0.3) return;
      const sign = dot > 0 ? 1 : -1;
      const d = (rw.at - railLane.along) * sign - RAIL_HALF - STOP_LINE_OFFSET;
      const st = this.railTrack.get(i);
      if (d > 0 && d <= STOP_ZONE) {
        this.railTrack.set(i, {
          minSpeed: Math.min(st?.minSpeed ?? Infinity, Math.abs(player.speed)),
          prevD: d,
        });
      } else if (d <= 0) {
        if (st && st.prevD > 0 && moving) {
          if (rw.light) {
            // мигающий красный: прощается, если при включении мигания
            // остановиться было уже нельзя (ср. правило жёлтого)
            const elapsed = this.map.railFlashElapsed(i, time);
            if (elapsed !== null) {
              const v = Math.abs(player.speed);
              if (elapsed * v > (v * v) / 8 + 1) emit('railway');
            }
          } else if (st.minSpeed > FULL_STOP_V) {
            emit('railway');
          }
        }
        this.railTrack.delete(i);
      } else {
        this.railTrack.delete(i);
      }
    });

    // --- вход/выход из квадрата перекрёстка: приоритет ---
    const nodeIn = this.nodeAt(pos);
    if (this.inNode && this.inNode.node !== nodeIn) {
      // выход: левый поворот под встречного
      const st = this.inNode;
      const n = this.map.nodes[st.node];
      const exitSide = dirOfVec({ x: pos.x - n.x, y: pos.y - n.y });
      if (st.entrySide !== null && st.oncomingSeen && exitSide === leftExitOf(st.entrySide)) {
        emit('priority');
      }
      // разворот под знаком 431: выехал (передом) туда же, откуда въехал
      if (st.entrySide !== null && exitSide === st.entrySide && n.noUTurn && player.speed > 0.3) {
        emit('no-u-turn');
      }
      // поворот на односторонку (две полосы одного направления) должен
      // завершиться в «своей» полосе: правый — в правой (тк. 42), левый —
      // в левой (тк. 43). Кольцо не судим: ringPath выводит направо.
      if (
        st.entrySide !== null &&
        exitSide !== st.entrySide &&
        exitSide !== opposite(st.entrySide) &&
        n.control !== 'roundabout'
      ) {
        const outEdge = this.map.nodeEdges(st.node)[exitSide];
        if (outEdge !== undefined) {
          const e = this.map.edges[outEdge];
          if (e.oneWay && e.a === st.node) {
            const f = DIR_VEC[opposite(st.entrySide)];
            const o = DIR_VEC[exitSide];
            const right = f.x * o.y - f.y * o.x > 0;
            this.laneCheck = { node: st.node, edge: outEdge, want: right ? 1 : -1 };
          }
        }
      }
      this.inNode = null;
    }
    if (nodeIn !== null && this.inNode === null) {
      this.laneCheck = null; // въехал в следующий узел — прежняя проверка неактуальна
      const entrySide =
        this.prevApproach && this.prevApproach.node === nodeIn
          ? this.prevApproach.side
          : approach && approach.node === nodeIn
            ? approach.side
            : null;
      this.inNode = { node: nodeIn, entrySide, committed: false, oncomingSeen: false };
      if (entrySide !== null && moving) {
        const type = this.entryConflict(nodeIn, entrySide, player, vehicles);
        if (type) emit(type);
      }
    }
    if (this.inNode && this.inNode.entrySide !== null && !this.inNode.committed) {
      // встречный при левом повороте — на момент НАЧАЛА манёвра: при въезде
      // в квадрат или трогании после остановки в нём. Появившийся позже,
      // когда поворот уже идёт, уступает сам (ср. прощение жёлтого)
      this.inNode.oncomingSeen = this.hasOncoming(this.inNode.node, this.inNode.entrySide, vehicles);
      if (moving) this.inNode.committed = true;
    }

    // --- полоса после поворота на односторонку: судим, когда игрок
    // отъехал от узла и определился с полосой ---
    if (this.laneCheck && nodeIn === null) {
      const lc = this.laneCheck;
      const lane = this.map.nearestLane(pos);
      if (lane && lane.edge === lc.edge) {
        const distFromNode = lane.along; // ребро выезда начинается в узле (e.a === node)
        const settled = Math.abs(lane.lateral) > 0.8 || distFromNode > this.map.nodeRadius(lc.node) + 8;
        if (distFromNode > this.map.nodeRadius(lc.node) + 2 && settled) {
          if ((lane.lateral >= 0 ? 1 : -1) !== lc.want) emit('turn-lane');
          this.laneCheck = null;
        }
      } else if (lane) {
        this.laneCheck = null; // ушёл на другое ребро — не судим
      }
    }

    // --- скорость ---
    const limit = this.map.speedLimitAt(pos) / 3.6;
    if (Math.abs(player.speed) > limit + SPEED_TOL) {
      this.speedingAcc += dt;
      if (this.speedingAcc >= SPEEDING_DELAY && !this.speedingLatched) {
        this.speedingLatched = true;
        emit('speeding');
      }
    } else if (Math.abs(player.speed) <= limit) {
      this.speedingAcc = 0;
      this.speedingLatched = false;
    }

    // --- задний ход (едущий назад не считается «встречкой») ---
    if (player.speed < -1) {
      this.reverseAcc += dt;
      if (this.reverseAcc >= REVERSE_DELAY && !this.reverseLatched) {
        this.reverseLatched = true;
        emit('reverse');
      }
    } else if (player.speed >= 0) {
      this.reverseAcc = 0;
      this.reverseLatched = false;
    }

    // --- встречка / односторонка ---
    if (this.isWrongWay(player)) {
      this.wrongWayAcc += dt;
      if (this.wrongWayAcc >= WRONG_WAY_DELAY && !this.wrongWayLatched) {
        this.wrongWayLatched = true;
        emit('wrong-way');
      }
    } else {
      this.wrongWayAcc = 0;
      this.wrongWayLatched = false;
    }

    // --- пешеходы на зебре ---
    const playerOBB = viewOBB(player);
    this.map.crosswalks().forEach((cw, i) => {
      const inCw = obbIntersect(playerOBB, rectOBB(cw.rect));
      const wasIn = this.pedPrevIn.get(i) ?? false;
      if (inCw && !wasIn) {
        const pedOn = peds.some((p) => p.crosswalk === i && p.onRoad);
        if (pedOn) emit('pedestrian');
      }
      this.pedPrevIn.set(i, inCw);
    });

    // --- полотно ---
    if (!this.map.isOnRoad(pos)) {
      this.offRoadAcc += dt;
      if (this.offRoadAcc >= OFF_ROAD_DELAY && !this.offRoadLatched) {
        this.offRoadLatched = true;
        emit('off-road');
      }
    } else {
      this.offRoadAcc = 0;
      this.offRoadLatched = false;
    }

    // --- столкновения ---
    for (const v of vehicles) {
      const hit = obbIntersect(playerOBB, viewOBB(v));
      if (hit && !this.vehicleContacts.has(v.id)) {
        this.vehicleContacts.add(v.id);
        emit('collision');
      }
      if (!hit) this.vehicleContacts.delete(v.id);
    }
    this.map.buildings.forEach((b, i) => {
      const hit = obbIntersect(playerOBB, rectOBB(b));
      if (hit && !this.buildingContacts.has(i)) {
        this.buildingContacts.add(i);
        emit('collision');
      }
      if (!hit) this.buildingContacts.delete(i);
    });

    this.prevApproach = approach ?? this.prevApproach;
    return out;
  }

  /** Куда едет игрок: узел впереди по текущей полосе. */
  private playerApproach(player: ActorView): Approach | null {
    if (Math.abs(player.speed) <= 0.05 && this.prevApproach) return this.prevApproach;
    return approachOf(this.map, player);
  }

  private nodeAt(p: Vec2): number | null {
    for (let i = 0; i < this.map.nodes.length; i++) {
      if (this.map.inNodeArea(i, p)) return i;
    }
    return null;
  }

  private isMinorSide(nodeId: number, side: Dir): boolean {
    const n = this.map.nodes[nodeId];
    if (n.control !== 'priority') return false;
    const mainSides: Dir[] = n.mainAxis === 'h' ? ['E', 'W'] : ['N', 'S'];
    return !mainSides.includes(side);
  }

  /** Нарушение приоритета при въезде в перекрёсток. */
  private entryConflict(
    nodeId: number,
    entrySide: Dir,
    player: ActorView,
    vehicles: ActorView[],
  ): ViolationType | null {
    const n = this.map.nodes[nodeId];
    if (n.control === 'lights') {
      // регулируемый: приоритет задаёт светофор (левый поворот — отдельно)
      return null;
    }
    if (n.control === 'roundabout') {
      // въезжающий уступает всем, кто уже на кольце
      for (const v of vehicles) {
        if (Math.abs(v.speed) < 0.8) continue;
        if (this.map.inNodeArea(nodeId, { x: v.x, y: v.y })) return 'priority';
      }
      return null;
    }
    let conflictSides: Dir[];
    if (n.control === 'priority' && this.isMinorSide(nodeId, entrySide)) {
      conflictSides = n.mainAxis === 'h' ? ['E', 'W'] : ['N', 'S'];
    } else if (n.control === 'none') {
      conflictSides = [rightApproachOf(entrySide)];
    } else {
      conflictSides = []; // на главной уступать некому (кроме встречного при левом)
    }
    for (const v of vehicles) {
      if (Math.abs(v.speed) < 0.8) continue;
      // машина уже в квадрате: помеха, только если траектории сближаются —
      // одновременный въезд с непересекающимися путями легален (ПДД:
      // «уступить» = не вынуждать менять скорость/направление)
      if (this.vehicleInBox(v, nodeId)) {
        if (raysConverge(player, v)) return 'priority';
        continue;
      }
      const ap = this.vehicleApproach(v);
      if (!ap || ap.node !== nodeId) continue;
      // помеха и по расстоянию, и по времени прибытия: только что
      // тронувшийся вдалеке NPC — ещё не помеха
      const tta = ap.d / Math.max(Math.abs(v.speed), 0.5);
      if (ap.d > -2 && ap.d < CONFLICT_DIST && tta < CONFLICT_TTA && conflictSides.includes(ap.side)) {
        return 'priority';
      }
    }
    return null;
  }

  private hasOncoming(nodeId: number, entrySide: Dir, vehicles: ActorView[]): boolean {
    // на кольце встречных нет: приоритет решается занятостью кольца
    if (this.map.nodes[nodeId].control === 'roundabout') return false;
    const oncomingSide = opposite(entrySide);
    const entryTravel = DIR_VEC[opposite(entrySide)];
    for (const v of vehicles) {
      if (Math.abs(v.speed) < 0.8) continue;
      if (this.vehicleInBox(v, nodeId)) {
        const tv = travelDir(v);
        if (tv.x * entryTravel.x + tv.y * entryTravel.y < -0.3) return true;
        continue;
      }
      const ap = this.vehicleApproach(v);
      if (ap && ap.node === nodeId && ap.side === oncomingSide && ap.d > -2 && ap.d < ONCOMING_DIST) {
        return true;
      }
    }
    return false;
  }

  private vehicleInBox(v: ActorView, nodeId: number): boolean {
    return this.map.inNodeArea(nodeId, { x: v.x, y: v.y });
  }

  private vehicleApproach(v: ActorView): Approach | null {
    return approachOf(this.map, v);
  }

  private isWrongWay(player: ActorView): boolean {
    if (player.speed < 0) return false; // задний ход — отдельное нарушение
    if (Math.abs(player.speed) < 1) return false;
    const pos = { x: player.x, y: player.y };
    const nodeId = this.nodeAt(pos);
    if (nodeId !== null) {
      // на кольце поток идёт против часовой (на экране): движение по часовой
      // — «встречка». Горловины и кромки не судим (там въезд/выезд).
      const n = this.map.nodes[nodeId];
      if (n.control !== 'roundabout') return false;
      const rx = pos.x - n.x;
      const ry = pos.y - n.y;
      const d = Math.hypot(rx, ry);
      if (d < ROUNDABOUT_ISLAND_R + 0.5 || d > ROUNDABOUT_R - 0.5) return false;
      const t = travelDir(player);
      // r × t > 0 — угол atan2 растёт, то есть едем по часовой (против потока)
      return (rx * t.y - ry * t.x) / d > 0.35;
    }
    const lane = this.map.nearestLane(pos);
    if (!lane) return false;
    const len = this.map.edgeLen(lane.edge);
    // манёвры у перекрёстков (повороты) не считаем
    if (lane.along < 7.5 || lane.along > len - 7.5) return false;
    const travel = travelDir(player);
    const u = this.map.edgeUnit(lane.edge);
    const dot = u.x * travel.x + u.y * travel.y;
    if (Math.abs(dot) < 0.5) return false;
    const actualSign = dot > 0 ? 1 : -1;
    if (this.map.edges[lane.edge].oneWay) return actualSign !== 1;
    if (Math.abs(lane.lateral) < 0.5) return false; // прямо на осевой
    const laneSign = lane.lateral >= 0 ? 1 : -1;
    return actualSign !== laneSign;
  }
}

function travelDir(v: ActorView): Vec2 {
  const h = v.speed >= 0 ? v.heading : v.heading + Math.PI;
  return { x: Math.cos(h), y: Math.sin(h) };
}

/** Сближаются ли пути двух машин (лучи по текущим курсам, ближайшие ~15 м)
 * меньше чем на 2.8 м. Курс поворачивающего в дуге — приближение. */
function raysConverge(a: ActorView, b: ActorView): boolean {
  const ta = travelDir(a);
  const tb = travelDir(b);
  // попутный впереди — вопрос дистанции, а не уступания
  if (ta.x * tb.x + ta.y * tb.y > 0.7) {
    if ((b.x - a.x) * ta.x + (b.y - a.y) * ta.y > 0) return false;
  }
  for (let i = 0; i <= 10; i++) {
    const ax = a.x + ta.x * 1.5 * i;
    const ay = a.y + ta.y * 1.5 * i;
    for (let j = 0; j <= 10; j++) {
      const bx = b.x + tb.x * 1.5 * j;
      const by = b.y + tb.y * 1.5 * j;
      if (Math.hypot(ax - bx, ay - by) < 2.8) return true;
    }
  }
  return false;
}

function viewOBB(v: ActorView): OBB {
  return { cx: v.x, cy: v.y, hx: v.length / 2, hy: v.width / 2, angle: v.heading };
}

function rectOBB(r: { xMin: number; xMax: number; yMin: number; yMax: number }): OBB {
  return {
    cx: (r.xMin + r.xMax) / 2,
    cy: (r.yMin + r.yMax) / 2,
    hx: (r.xMax - r.xMin) / 2,
    hy: (r.yMax - r.yMin) / 2,
    angle: 0,
  };
}

/** Сторона, куда выезжают при левом повороте с entrySide. */
function leftExitOf(entrySide: Dir): Dir {
  const travel = DIR_VEC[opposite(entrySide)];
  const right = rightOf(travel);
  return dirOfVec({ x: -right.x, y: -right.y });
}

/** Сторона, с которой приходит «помеха справа». */
function rightApproachOf(entrySide: Dir): Dir {
  const travel = DIR_VEC[opposite(entrySide)];
  return dirOfVec(rightOf(travel));
}
