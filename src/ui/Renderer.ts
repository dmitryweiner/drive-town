import type { Car } from '../game/Car';
import type { Vec2 } from '../game/Car';
import {
  CityMap,
  CROSSWALK_LEN,
  DIR_VEC,
  HALF_ROAD,
  STOP_LINE_OFFSET,
  opposite,
  rightOf,
} from '../game/CityMap';
import { GOAL_RADIUS } from '../game/generate';
import type { Round } from '../game/Round';
import { KIND_SIZE } from '../game/Traffic';
import type { Dir, LightState, Rect, VehicleKind } from '../game/types';

const MIN_ZOOM = 0.5;
const MAX_ZOOM = 4;
const MAX_DPR = 2;
/** Видимая высота мира при zoom=1, м. */
const VIEW_M = 72;

const GRASS = '#2c4034';
const ASPHALT = '#3a3f4a';
const MARK = '#e8e8e8';
/** Дома: приглушённые «городские» цвета; крыша чуть светлее стен. */
const BUILDING_PALETTE: { wall: string; roof: string }[] = [
  { wall: '#7a5c48', roof: '#8f705a' }, // кирпичный
  { wall: '#6e7078', roof: '#83858e' }, // серый
  { wall: '#8a7a5c', roof: '#a09070' }, // бежевый
  { wall: '#5d6b58', roof: '#71816b' }, // оливковый
  { wall: '#7d5a5a', roof: '#946f6f' }, // терракотовый
  { wall: '#5a6b7d', roof: '#6f8394' }, // сине-серый
];

export class Renderer {
  private zoom = 1;

  constructor(private readonly canvas: HTMLCanvasElement) {}

  resize(): void {
    const vv = window.visualViewport;
    const cssW = vv ? vv.width : window.innerWidth;
    const cssH = vv ? vv.height : window.innerHeight;
    const dpr = Math.min(window.devicePixelRatio || 1, MAX_DPR);
    this.canvas.width = Math.max(1, Math.round(cssW * dpr));
    this.canvas.height = Math.max(1, Math.round(cssH * dpr));
    this.canvas.style.width = `${cssW}px`;
    this.canvas.style.height = `${cssH}px`;
  }

  getZoom(): number {
    return this.zoom;
  }

  setZoom(z: number): void {
    this.zoom = clamp(z, MIN_ZOOM, MAX_ZOOM);
  }

  zoomBy(factor: number): void {
    this.setZoom(this.zoom * factor);
  }

  render(round: Round): void {
    const ctx = this.canvas.getContext('2d');
    if (!ctx) return;
    const w = this.canvas.width;
    const h = this.canvas.height;
    const map = round.plan.map;

    ctx.fillStyle = GRASS;
    ctx.fillRect(0, 0, w, h);

    const scale = (Math.min(w, h) / VIEW_M) * this.zoom;
    ctx.save();
    ctx.translate(w / 2, h / 2);
    ctx.scale(scale, scale);
    ctx.translate(-round.car.position.x, -round.car.position.y);

    this.drawCity(ctx, map, round.time);
    this.drawGoal(ctx, round.plan.goal, round.time);

    // участники движения
    const kinds = round.traffic.vehicleKinds();
    const colors = round.traffic.vehicleColors();
    round.traffic.vehicleViews().forEach((v, i) => {
      drawNpcVehicle(ctx, v.x, v.y, v.heading, kinds[i], colors[i]);
    });
    for (const p of round.traffic.pedViews()) drawPedestrian(ctx, p);
    drawPlayerCar(ctx, round.car);

    // знаки и светофоры поверх машин
    this.drawFurniture(ctx, map, round.time);

    ctx.restore();
  }

  // ==== город ====

  private drawCity(ctx: CanvasRenderingContext2D, map: CityMap, time: number): void {
    void time;
    // полотно
    ctx.fillStyle = ASPHALT;
    for (let i = 0; i < map.edges.length; i++) {
      const r = map.edgeRoadRect(i);
      ctx.fillRect(r.xMin, r.yMin, r.xMax - r.xMin, r.yMax - r.yMin);
    }
    for (let i = 0; i < map.nodes.length; i++) {
      const b = map.nodeBox(i);
      ctx.fillRect(b.xMin, b.yMin, b.xMax - b.xMin, b.yMax - b.yMin);
    }

    // дома: цвет детерминирован индексом, «крыша» — внутренний прямоугольник
    map.buildings.forEach((bld, i) => {
      const c = BUILDING_PALETTE[i % BUILDING_PALETTE.length];
      const w = bld.xMax - bld.xMin;
      const h = bld.yMax - bld.yMin;
      ctx.fillStyle = c.wall;
      ctx.fillRect(bld.xMin, bld.yMin, w, h);
      const in1 = Math.min(1.6, w / 4, h / 4);
      ctx.fillStyle = c.roof;
      ctx.fillRect(bld.xMin + in1, bld.yMin + in1, w - 2 * in1, h - 2 * in1);
      ctx.strokeStyle = 'rgba(0,0,0,0.35)';
      ctx.lineWidth = 0.35;
      ctx.strokeRect(bld.xMin, bld.yMin, w, h);
    });

    // разметка рёбер
    for (let i = 0; i < map.edges.length; i++) this.drawEdgeMarkings(ctx, map, i);

    // границы узлов на сторонах без дорог
    for (let i = 0; i < map.nodes.length; i++) this.drawNodeOutline(ctx, map, i);

    // стоп-линии на регулируемых подъездах
    for (let i = 0; i < map.nodes.length; i++) this.drawStopLines(ctx, map, i);

    // зебры
    for (const cw of map.crosswalks()) drawZebra(ctx, cw.rect);

    // отметка лимита на асфальте в начале зоны
    ctx.fillStyle = 'rgba(255,255,255,0.85)';
    ctx.font = 'bold 2px sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    for (let i = 0; i < map.edges.length; i++) {
      const e = map.edges[i];
      if (e.speedLimit === undefined) continue;
      const len = map.edgeLen(i);
      for (const dirSign of map.allowedDirSigns(i)) {
        const along = dirSign > 0 ? HALF_ROAD + 6 : len - HALF_ROAD - 6;
        const p = map.lanePoint(i, dirSign, along);
        ctx.fillText(String(e.speedLimit), p.x, p.y);
      }
    }
  }

  private drawEdgeMarkings(ctx: CanvasRenderingContext2D, map: CityMap, edgeId: number): void {
    const r = map.edgeRoadRect(edgeId);
    const e = map.edges[edgeId];
    const a = map.nodes[e.a];
    const u = map.edgeUnit(edgeId);
    const vertical = u.y !== 0;
    ctx.strokeStyle = MARK;
    const line = (lat: number, dashed: boolean, width: number): void => {
      ctx.lineWidth = width;
      ctx.setLineDash(dashed ? [1.8, 1.8] : []);
      ctx.beginPath();
      if (vertical) {
        ctx.moveTo(a.x + lat, r.yMin);
        ctx.lineTo(a.x + lat, r.yMax);
      } else {
        ctx.moveTo(r.xMin, a.y + lat);
        ctx.lineTo(r.xMax, a.y + lat);
      }
      ctx.stroke();
      ctx.setLineDash([]);
    };
    // края полотна
    line(-HALF_ROAD, false, 0.22);
    line(HALF_ROAD, false, 0.22);
    // осевая: сплошная у двусторонней, пунктир между полосами односторонней
    line(0, Boolean(e.oneWay), 0.2);

    // стрелки направления на односторонней
    if (e.oneWay) {
      const len = map.edgeLen(edgeId);
      const heading = Math.atan2(u.y, u.x);
      for (let along = HALF_ROAD + 12; along < len - HALF_ROAD - 6; along += 30) {
        for (const lat of [-2.25, 2.25]) {
          const p = { x: a.x + u.x * along + rightOf(u).x * lat, y: a.y + u.y * along + rightOf(u).y * lat };
          drawStraightArrow(ctx, p.x, p.y, heading);
        }
      }
    }
  }

  /** Кромка узла со сторон, где нет дорог (углы, тупики). */
  private drawNodeOutline(ctx: CanvasRenderingContext2D, map: CityMap, nodeId: number): void {
    const b = map.nodeBox(nodeId);
    const edges = map.nodeEdges(nodeId);
    ctx.strokeStyle = MARK;
    ctx.lineWidth = 0.22;
    const seg = (x1: number, y1: number, x2: number, y2: number): void => {
      ctx.beginPath();
      ctx.moveTo(x1, y1);
      ctx.lineTo(x2, y2);
      ctx.stroke();
    };
    if (edges.N === undefined) seg(b.xMin, b.yMin, b.xMax, b.yMin);
    if (edges.S === undefined) seg(b.xMin, b.yMax, b.xMax, b.yMax);
    if (edges.W === undefined) seg(b.xMin, b.yMin, b.xMin, b.yMax);
    if (edges.E === undefined) seg(b.xMax, b.yMin, b.xMax, b.yMax);
  }

  private drawStopLines(ctx: CanvasRenderingContext2D, map: CityMap, nodeId: number): void {
    const n = map.nodes[nodeId];
    if (n.control !== 'lights' && n.control !== 'priority') return;
    const node = { x: n.x, y: n.y };
    for (const side of SIDES) {
      const edgeId = map.nodeEdges(nodeId)[side];
      if (edgeId === undefined) continue;
      // на въезд со стороны side (может быть запрещён односторонкой)
      if (!map.canTravel(edgeId, map.otherNode(edgeId, nodeId))) continue;
      const isStop =
        n.control === 'lights' ||
        (n.control === 'priority' && isMinor(n.mainAxis, side));
      if (!isStop) continue;
      const f = DIR_VEC[opposite(side)]; // направление движения к узлу
      const rt = rightOf(f);
      const base = {
        x: node.x - f.x * (HALF_ROAD + STOP_LINE_OFFSET),
        y: node.y - f.y * (HALF_ROAD + STOP_LINE_OFFSET),
      };
      ctx.strokeStyle = MARK;
      ctx.lineWidth = n.control === 'priority' && n.minorSign === 'yield' ? 0.3 : 0.5;
      ctx.setLineDash(n.control === 'priority' && n.minorSign === 'yield' ? [0.8, 0.8] : []);
      ctx.beginPath();
      ctx.moveTo(base.x, base.y);
      ctx.lineTo(base.x + rt.x * HALF_ROAD, base.y + rt.y * HALF_ROAD);
      ctx.stroke();
      ctx.setLineDash([]);
    }
  }

  private drawGoal(ctx: CanvasRenderingContext2D, goal: Vec2, time: number): void {
    // пульсирующий круг зачёта
    const pulse = 0.55 + 0.25 * Math.sin(time * 3);
    ctx.strokeStyle = `rgba(255, 90, 90, ${pulse})`;
    ctx.lineWidth = 0.5;
    ctx.beginPath();
    ctx.arc(goal.x, goal.y, GOAL_RADIUS, 0, Math.PI * 2);
    ctx.stroke();
    ctx.fillStyle = 'rgba(255, 90, 90, 0.15)';
    ctx.fill();
    // флажок
    ctx.strokeStyle = '#e8e8e8';
    ctx.lineWidth = 0.3;
    ctx.beginPath();
    ctx.moveTo(goal.x, goal.y);
    ctx.lineTo(goal.x, goal.y - 4);
    ctx.stroke();
    ctx.fillStyle = '#ff5a5a';
    ctx.beginPath();
    ctx.moveTo(goal.x, goal.y - 4);
    ctx.lineTo(goal.x + 2.6, goal.y - 3.2);
    ctx.lineTo(goal.x, goal.y - 2.4);
    ctx.closePath();
    ctx.fill();
  }

  // ==== знаки и светофоры ====

  private drawFurniture(ctx: CanvasRenderingContext2D, map: CityMap, time: number): void {
    // занятые места (светофоры и знаки): новые знаки при пересечении
    // сдвигаются вдоль дороги, чтобы ничего не закрывать
    const placed: Vec2[] = [];
    const occupy = (p: Vec2): void => {
      placed.push(p);
    };
    const placeSign = (pos: Vec2, away: Vec2, num: string, travel: Vec2): void => {
      const p = { ...pos };
      let guard = 0;
      while (placed.some((q) => Math.hypot(q.x - p.x, q.y - p.y) < 3.4) && guard++ < 4) {
        p.x += away.x * 3.4;
        p.y += away.y * 3.4;
      }
      occupy(p);
      drawSign(ctx, p.x, p.y, num, signAngle(travel));
    };

    for (let i = 0; i < map.nodes.length; i++) {
      const n = map.nodes[i];
      for (const side of SIDES) {
        const edgeId = map.nodeEdges(i)[side];
        if (edgeId === undefined) continue;
        const canEnter = map.canTravel(edgeId, map.otherNode(edgeId, i));
        const pos = signPos(n, side, 0);
        if (n.control === 'lights' && canEnter) {
          occupy(pos);
          drawTrafficLight(ctx, pos.x, pos.y, map.lightState(i, side, time) ?? 'red');
          continue;
        }
        if (n.control === 'priority' && canEnter) {
          occupy(pos);
          const num = isMinor(n.mainAxis, side) ? (n.minorSign === 'stop' ? '302' : '301') : '309';
          drawSign(ctx, pos.x, pos.y, num, signAngle(DIR_VEC[opposite(side)]));
        }
      }
    }
    // знаки на рёбрах: лимиты, односторонка, зебры
    for (let i = 0; i < map.edges.length; i++) {
      const e = map.edges[i];
      const u = map.edgeUnit(i);
      const a = map.nodes[e.a];
      const len = map.edgeLen(i);
      const at = (along: number, dirSign: number): Vec2 => {
        const rt = rightOf({ x: u.x * dirSign, y: u.y * dirSign });
        return {
          x: a.x + u.x * along + rt.x * (HALF_ROAD + 1.6),
          y: a.y + u.y * along + rt.y * (HALF_ROAD + 1.6),
        };
      };
      if (e.oneWay) {
        // «одностороннее движение» — в начале, «въезд запрещён» — лицом
        // к нарушителю с конца b; оба подальше от перекрёстков, чтобы
        // не закрывать светофоры соседних подъездов
        placeSign(at(HALF_ROAD + 8, 1), u, '618', u);
        const back = { x: -u.x, y: -u.y };
        placeSign(at(len - HALF_ROAD - 8, -1), back, '402', back);
      }
      if (e.speedLimit !== undefined) {
        for (const dirSign of map.allowedDirSigns(i)) {
          const along = dirSign > 0 ? HALF_ROAD + 4.5 : len - HALF_ROAD - 4.5;
          const dir = { x: u.x * dirSign, y: u.y * dirSign };
          placeSign(at(along, dirSign), dir, `426-${e.speedLimit}`, dir);
        }
      }
      for (const cw of map.crosswalks()) {
        if (cw.edge !== i) continue;
        for (const dirSign of map.allowedDirSigns(i)) {
          const along = cw.at - dirSign * (CROSSWALK_LEN / 2 + 4);
          const dir = { x: u.x * dirSign, y: u.y * dirSign };
          placeSign(at(along, dirSign), { x: -dir.x, y: -dir.y }, '306', dir);
        }
      }
    }
  }
}

const SIDES: readonly Dir[] = ['N', 'E', 'S', 'W'];

function isMinor(mainAxis: 'h' | 'v' | undefined, side: Dir): boolean {
  const main: readonly Dir[] = mainAxis === 'h' ? ['E', 'W'] : ['N', 'S'];
  return !main.includes(side);
}

/** Место знака/светофора подъезда: справа от полосы, чуть до стоп-линии. */
function signPos(node: { x: number; y: number }, side: Dir, slot: number): Vec2 {
  const f = DIR_VEC[opposite(side)]; // направление движения к узлу
  const back = DIR_VEC[side];
  const rt = rightOf(f);
  const dist = HALF_ROAD + 2.4 + slot * 3.2;
  return {
    x: node.x + back.x * dist + rt.x * (HALF_ROAD + 1.6),
    y: node.y + back.y * dist + rt.y * (HALF_ROAD + 1.6),
  };
}

// ==== примитивы (из driving-trainer) ====

function drawZebra(ctx: CanvasRenderingContext2D, r: Rect): void {
  ctx.fillStyle = 'rgba(240,240,240,0.85)';
  const horizontal = r.xMax - r.xMin >= r.yMax - r.yMin;
  if (horizontal) {
    for (let x = r.xMin + 0.4; x < r.xMax - 0.6; x += 1.5) {
      ctx.fillRect(x, r.yMin + 0.2, 0.8, r.yMax - r.yMin - 0.4);
    }
  } else {
    for (let y = r.yMin + 0.4; y < r.yMax - 0.6; y += 1.5) {
      ctx.fillRect(r.xMin + 0.2, y, r.xMax - r.xMin - 0.4, 0.8);
    }
  }
}

function drawStraightArrow(ctx: CanvasRenderingContext2D, x: number, y: number, heading: number): void {
  ctx.save();
  ctx.translate(x, y);
  ctx.rotate(heading + Math.PI / 2); // локально: вперёд = -y
  ctx.strokeStyle = 'rgba(255,255,255,0.7)';
  ctx.fillStyle = 'rgba(255,255,255,0.7)';
  ctx.lineWidth = 0.34;
  ctx.lineCap = 'round';
  ctx.beginPath();
  ctx.moveTo(0, 1.8);
  ctx.lineTo(0, -0.9);
  ctx.stroke();
  ctx.beginPath();
  ctx.moveTo(0, -2.2);
  ctx.lineTo(-0.42, -0.85);
  ctx.lineTo(0.42, -0.85);
  ctx.closePath();
  ctx.fill();
  ctx.restore();
}

function drawTrafficLight(ctx: CanvasRenderingContext2D, x: number, y: number, state: LightState): void {
  ctx.save();
  ctx.translate(x, y);
  ctx.fillStyle = '#22242a';
  const w = 1.6;
  const h = 4.2;
  ctx.fillRect(-w / 2, -h / 2, w, h);
  const lamps: [string, boolean][] = [
    ['#ff3b30', state === 'red' || state === 'red-yellow'],
    ['#ffcc00', state === 'yellow' || state === 'red-yellow'],
    ['#34c759', state === 'green'],
  ];
  for (const [i, [color, on]] of lamps.entries()) {
    ctx.fillStyle = on ? color : '#3a3d45';
    ctx.beginPath();
    ctx.arc(0, -1.3 + i * 1.3, 0.5, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.restore();
}

const signImages = new Map<string, HTMLImageElement>();

function signImage(num: string): HTMLImageElement {
  let img = signImages.get(num);
  if (!img) {
    img = new Image();
    img.src = `signs/${num}.png`;
    signImages.set(num, img);
  }
  return img;
}

/** Высота знака в метрах мира (картинки 78×63). */
const SIGN_H = 3.0;
const SIGN_W = SIGN_H * (78 / 63);

/** Поворот знака: «верх» картинки — по ходу движения подъезда. */
function signAngle(travel: Vec2): number {
  return Math.atan2(travel.y, travel.x) + Math.PI / 2;
}

function drawSign(ctx: CanvasRenderingContext2D, x: number, y: number, num: string, angle = 0): void {
  const img = signImage(num);
  if (!img.complete || img.naturalWidth === 0) return; // появится на следующем кадре
  ctx.save();
  ctx.translate(x, y);
  ctx.rotate(angle);
  ctx.drawImage(img, -SIGN_W / 2, -SIGN_H / 2, SIGN_W, SIGN_H);
  ctx.restore();
}

function drawNpcVehicle(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  heading: number,
  kind: VehicleKind,
  color: string,
): void {
  const { length, width } = KIND_SIZE[kind];
  if (kind === 'bicycle' || kind === 'motorcycle') {
    ctx.save();
    ctx.translate(x, y);
    ctx.rotate(heading);
    const hl = length / 2;
    // колёса — вытянутые тёмные «капсулы»
    ctx.fillStyle = '#1c1e22';
    roundRect(ctx, hl - 0.85, -0.14, 0.85, 0.28, 0.14);
    ctx.fill();
    roundRect(ctx, -hl, -0.14, 0.85, 0.28, 0.14);
    ctx.fill();
    ctx.strokeStyle = color;
    ctx.lineWidth = kind === 'motorcycle' ? 0.34 : 0.2;
    ctx.lineCap = 'round';
    ctx.beginPath();
    ctx.moveTo(-hl + 0.4, 0);
    ctx.lineTo(hl - 0.4, 0);
    ctx.stroke();
    ctx.lineWidth = 0.16;
    ctx.beginPath();
    ctx.moveTo(hl - 0.55, -0.55);
    ctx.lineTo(hl - 0.55, 0.55);
    ctx.stroke();
    // водитель: плечи + голова (у мото — шлем)
    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.ellipse(-0.25, 0, 0.42, 0.62, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = kind === 'motorcycle' ? '#2b2f38' : '#f5d6a8';
    ctx.beginPath();
    ctx.arc(0.05, 0, 0.3, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = 'rgba(20,20,20,0.55)';
    ctx.lineWidth = 0.06;
    ctx.stroke();
    ctx.restore();
    return;
  }
  drawCarBody(ctx, {
    cx: x,
    cy: y,
    angle: heading,
    hl: length / 2,
    hw: width / 2,
    bodyColor: color,
    windshieldColor: '#222',
    headlightColor: '#fff',
    taillightColor: '#a52323',
  });
}

function drawPedestrian(ctx: CanvasRenderingContext2D, ped: { x: number; y: number }): void {
  ctx.save();
  ctx.translate(ped.x, ped.y);
  ctx.fillStyle = '#2563eb';
  ctx.strokeStyle = 'rgba(255,255,255,0.9)';
  ctx.lineWidth = 0.12;
  ctx.beginPath();
  ctx.ellipse(0, 0, 0.62, 0.42, 0, 0, Math.PI * 2);
  ctx.fill();
  ctx.stroke();
  ctx.fillStyle = '#f5d6a8';
  ctx.beginPath();
  ctx.arc(0, 0, 0.28, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();
}

function drawPlayerCar(ctx: CanvasRenderingContext2D, car: Car): void {
  const reversing = car.velocity < -0.05 || (car.velocity < 0.5 && car.brakeInput > 0.1);
  const braking = !reversing && car.brakeInput > 0.1;
  drawCarBody(ctx, {
    cx: car.position.x,
    cy: car.position.y,
    angle: car.heading,
    hl: car.length / 2,
    hw: car.width / 2,
    bodyColor: '#ffce4d',
    windshieldColor: '#222',
    headlightColor: '#fff',
    taillightColor: reversing ? '#ffffff' : braking ? '#ff2828' : '#a52323',
    glowTaillight: braking,
  });
}

interface CarVisual {
  cx: number;
  cy: number;
  angle: number;
  hl: number;
  hw: number;
  bodyColor: string;
  windshieldColor: string;
  headlightColor: string;
  taillightColor: string;
  glowTaillight?: boolean;
}

function drawCarBody(ctx: CanvasRenderingContext2D, v: CarVisual): void {
  ctx.save();
  ctx.translate(v.cx, v.cy);
  ctx.rotate(v.angle);
  ctx.fillStyle = v.bodyColor;
  roundRect(ctx, -v.hl, -v.hw, v.hl * 2, v.hw * 2, 0.4);
  ctx.fill();
  ctx.fillStyle = v.windshieldColor;
  ctx.fillRect(v.hl * 0.45, -v.hw * 0.75, v.hl * 0.35, v.hw * 1.5);

  ctx.fillStyle = v.headlightColor;
  ctx.beginPath();
  ctx.arc(v.hl * 0.95, -v.hw * 0.6, 0.15, 0, Math.PI * 2);
  ctx.arc(v.hl * 0.95, v.hw * 0.6, 0.15, 0, Math.PI * 2);
  ctx.fill();

  ctx.fillStyle = v.taillightColor;
  ctx.beginPath();
  ctx.arc(-v.hl * 0.95, -v.hw * 0.6, 0.18, 0, Math.PI * 2);
  ctx.arc(-v.hl * 0.95, v.hw * 0.6, 0.18, 0, Math.PI * 2);
  ctx.fill();
  if (v.glowTaillight) {
    ctx.shadowColor = '#ff2828';
    ctx.shadowBlur = 0.5;
    ctx.fill();
    ctx.shadowBlur = 0;
  }
  ctx.restore();
}

function roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number): void {
  const rr = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + rr, y);
  ctx.lineTo(x + w - rr, y);
  ctx.quadraticCurveTo(x + w, y, x + w, y + rr);
  ctx.lineTo(x + w, y + h - rr);
  ctx.quadraticCurveTo(x + w, y + h, x + w - rr, y + h);
  ctx.lineTo(x + rr, y + h);
  ctx.quadraticCurveTo(x, y + h, x, y + h - rr);
  ctx.lineTo(x, y + rr);
  ctx.quadraticCurveTo(x, y, x + rr, y);
  ctx.closePath();
}

function clamp(v: number, a: number, b: number): number {
  return Math.max(a, Math.min(b, v));
}
