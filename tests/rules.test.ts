import { beforeEach, describe, expect, it } from 'vitest';
import { RuleMonitor, type ActorView, type PedView } from '../src/game/Rules';
import type { ViolationType } from '../src/game/types';
import { cross } from './helpers/fixtures';

function actor(x: number, y: number, heading: number, speed: number, id = 0): ActorView {
  return { id, x, y, heading, speed, length: 4, width: 2 };
}

const N = -Math.PI / 2;
const S = Math.PI / 2;
const E = 0;
const W = Math.PI;

/** Прогоняет монитор по траектории с шагом dt, собирая нарушения. */
function drive(
  mon: RuleMonitor,
  steps: { x: number; y: number; heading: number; speed: number }[],
  opts: { dt?: number; t0?: number; vehicles?: ActorView[]; peds?: PedView[] } = {},
): ViolationType[] {
  const dt = opts.dt ?? 0.05;
  let t = opts.t0 ?? 0;
  const out: ViolationType[] = [];
  for (const s of steps) {
    t += dt;
    const vs = mon.update(dt, t, { id: -1, length: 4, width: 2, ...s }, opts.vehicles ?? [], opts.peds ?? []);
    out.push(...vs.map((v) => v.type));
  }
  return out;
}

/** Северное движение по восточной половине южного луча: y от y0 вниз до y1. */
function northRun(y0: number, y1: number, speed: number): { x: number; y: number; heading: number; speed: number }[] {
  const steps: { x: number; y: number; heading: number; speed: number }[] = [];
  const dt = 0.05;
  for (let y = y0; y >= y1; y -= speed * dt) {
    steps.push({ x: 2.25, y, heading: N, speed });
  }
  return steps;
}

describe('Rules: скорость', () => {
  it('превышение — одно событие на эпизод, после замедления взводится снова', () => {
    const map = cross();
    const mon = new RuleMonitor(map);
    const fast = northRun(80, 40, 16);         // 57.6 км/ч при лимите 50
    const slow = northRun(40, 30, 10);
    const fast2 = northRun(30, 12, 16);
    const all = [
      ...drive(mon, fast),
      ...drive(mon, slow),
      ...drive(mon, fast2),
    ];
    expect(all.filter((v) => v === 'speeding')).toHaveLength(2);
  });

  it('в пределах лимита нарушений нет', () => {
    const mon = new RuleMonitor(cross());
    expect(drive(mon, northRun(80, 20, 12))).toHaveLength(0);
  });
});

describe('Rules: светофор', () => {
  it('пересечение стоп-линии на красный — нарушение', () => {
    const map = cross({ control: 'lights' });
    const mon = new RuleMonitor(map);
    // подъезд с запада (сторона W) на t≈0 — красный
    const steps: { x: number; y: number; heading: number; speed: number }[] = [];
    for (let x = -20; x <= -2; x += 8 * 0.05) {
      steps.push({ x, y: -2.25, heading: E, speed: 8 });
    }
    const vs = drive(mon, steps);
    expect(vs).toContain('ran-light');
    expect(vs.filter((v) => v === 'ran-light')).toHaveLength(1);
  });

  it('жёлтый прощается, если тормозить уже поздно', () => {
    const map = cross({ control: 'lights' });
    const mon = new RuleMonitor(map);
    // вертикальная фаза: жёлтый в [8,10); пересекаем линию на 8.4 с, 8 м/с:
    // при включении жёлтого до линии было ~3 м — остановиться нельзя
    const y0 = 5.5 + 8 * 8.4;
    const vs = drive(mon, northRun(y0, 2, 8));
    expect(vs).not.toContain('ran-light');
  });

  it('жёлтый — нарушение, если можно было остановиться', () => {
    const map = cross({ control: 'lights' });
    const mon = new RuleMonitor(map);
    // пересечение на 9.9 с: жёлтый горит 1.9 с, при включении до линии
    // было ~15 м — остановиться было можно
    const y0 = 5.5 + 8 * 9.9;
    const vs = drive(mon, northRun(y0, 2, 8));
    expect(vs).toContain('ran-light');
  });

  it('на зелёный можно', () => {
    const map = cross({ control: 'lights' });
    const mon = new RuleMonitor(map);
    // вертикальная группа зелёная в начале цикла: едем с юга на север
    const vs = drive(mon, northRun(20, -20, 8));
    expect(vs).not.toContain('ran-light');
  });
});

describe('Rules: знак «стоп»', () => {
  it('проезд без полной остановки — нарушение', () => {
    const map = cross({ control: 'priority', mainAxis: 'h', minorSign: 'stop' });
    const mon = new RuleMonitor(map);
    const vs = drive(mon, northRun(20, -2, 6));
    expect(vs).toContain('ran-stop');
  });

  it('с полной остановкой в стоп-зоне — чисто', () => {
    const map = cross({ control: 'priority', mainAxis: 'h', minorSign: 'stop' });
    const mon = new RuleMonitor(map);
    const approach = northRun(20, 7, 5);
    const stopped = Array.from({ length: 20 }, () => ({ x: 2.25, y: 7, heading: N, speed: 0 }));
    const go = northRun(7, -2, 4);
    const vs = [
      ...drive(mon, approach),
      ...drive(mon, stopped),
      ...drive(mon, go),
    ];
    expect(vs).not.toContain('ran-stop');
  });
});

describe('Rules: приоритет', () => {
  it('выезд со второстепенной под машину на главной — нарушение', () => {
    const map = cross({ control: 'priority', mainAxis: 'h', minorSign: 'yield' });
    const mon = new RuleMonitor(map);
    // NPC по главной с востока, едет на запад, в 7 м до стоп-линии
    const npc = actor(12.5, -2.25, W, 7, 1);
    const vs = drive(mon, northRun(20, -2, 6), { vehicles: [npc] });
    expect(vs).toContain('priority');
  });

  it('пустая главная — проезд чистый', () => {
    const map = cross({ control: 'priority', mainAxis: 'h', minorSign: 'yield' });
    const mon = new RuleMonitor(map);
    const vs = drive(mon, northRun(20, -2, 6));
    expect(vs).not.toContain('priority');
  });

  it('правило правой руки на нерегулируемом', () => {
    const map = cross({ control: 'none' });
    const mon = new RuleMonitor(map);
    // помеха справа: NPC с востока (справа для едущего на север)
    const right = actor(12.5, -2.25, W, 7, 1);
    const vs1 = drive(mon, northRun(20, -2, 6), { vehicles: [right] });
    expect(vs1).toContain('priority');
    // NPC слева — уступать не обязан
    const mon2 = new RuleMonitor(map);
    const left = actor(-12.5, 2.25, E, 7, 1);
    const vs2 = drive(mon2, northRun(20, -2, 6), { vehicles: [left] });
    expect(vs2).not.toContain('priority');
  });

  it('левый поворот под встречного — нарушение', () => {
    const map = cross({ control: 'none' });
    const mon = new RuleMonitor(map);
    const oncoming = actor(-2.25, -9, S, 6, 1);
    // с юга налево на запад
    const path = [
      ...northRun(20, 5, 5),
      { x: 2, y: 2, heading: N + 0.5, speed: 5 },
      { x: 0, y: 0.5, heading: W - 0.7, speed: 5 },
      { x: -3, y: -1.5, heading: W - 0.3, speed: 5 },
      { x: -6, y: -2.25, heading: W, speed: 5 },
      { x: -12, y: -2.25, heading: W, speed: 5 },
    ];
    const vs = drive(mon, path, { vehicles: [oncoming] });
    expect(vs).toContain('priority');
  });

  it('встречный, появившийся когда поворот уже идёт, прощается', () => {
    const map = cross({ control: 'none' });
    const mon = new RuleMonitor(map);
    // въезжаем в квадрат при пустой дороге, манёвр уже идёт...
    const commit = [
      ...northRun(20, 5, 5),
      { x: 2, y: 2, heading: N + 0.5, speed: 5 },
    ];
    // ...и только теперь на встречной появляется машина
    const oncoming = actor(-2.25, -9, S, 6, 1);
    const finish = [
      { x: 0, y: 0.5, heading: W - 0.7, speed: 5 },
      { x: -3, y: -1.5, heading: W - 0.3, speed: 5 },
      { x: -6, y: -2.25, heading: W, speed: 5 },
      { x: -12, y: -2.25, heading: W, speed: 5 },
    ];
    const vs = [
      ...drive(mon, commit),
      ...drive(mon, finish, { vehicles: [oncoming] }),
    ];
    expect(vs).not.toContain('priority');
  });

  it('прямо при встречном — не нарушение', () => {
    const map = cross({ control: 'none' });
    const mon = new RuleMonitor(map);
    const oncoming = actor(-2.25, -9, S, 6, 1);
    const vs = drive(mon, northRun(20, -12, 6), { vehicles: [oncoming] });
    expect(vs).not.toContain('priority');
  });
});

describe('Rules: задний ход', () => {
  it('задний ход — отдельное нарушение, а не «встречная»', () => {
    const mon = new RuleMonitor(cross());
    // катимся назад по СВОЕЙ полосе: нос на север, машина едет на юг
    const steps: { x: number; y: number; heading: number; speed: number }[] = [];
    for (let y = 20; y <= 40; y += 3 * 0.05) {
      steps.push({ x: 2.25, y, heading: N, speed: -3 });
    }
    const vs = drive(mon, steps);
    expect(vs).toContain('reverse');
    expect(vs.filter((v) => v === 'reverse')).toHaveLength(1);
    expect(vs).not.toContain('wrong-way');
  });

  it('короткий манёвр назад прощается', () => {
    const mon = new RuleMonitor(cross());
    const steps: { x: number; y: number; heading: number; speed: number }[] = [];
    for (let y = 20; y <= 21; y += 2 * 0.05) {
      steps.push({ x: 2.25, y, heading: N, speed: -2 });
    }
    expect(drive(mon, steps)).not.toContain('reverse');
  });
});

describe('Rules: встречка и односторонка', () => {
  it('езда по встречной полосе — нарушение', () => {
    const mon = new RuleMonitor(cross());
    // южный луч, западная половина (полоса южного направления), едем на север
    const steps = Array.from({ length: 30 }, (_, i) => ({
      x: -2.25, y: 60 - i * 0.4, heading: N, speed: 8,
    }));
    const vs = drive(mon, steps);
    expect(vs).toContain('wrong-way');
    expect(vs.filter((v) => v === 'wrong-way')).toHaveLength(1);
  });

  it('против односторонней — нарушение с любой половины', () => {
    const mon = new RuleMonitor(cross({ oneWayE: true }));
    const steps = Array.from({ length: 30 }, (_, i) => ({
      x: 60 - i * 0.4, y: 2.25, heading: W, speed: 8,
    }));
    expect(drive(mon, steps)).toContain('wrong-way');
  });

  it('по своей полосе — чисто', () => {
    const mon = new RuleMonitor(cross());
    expect(drive(mon, northRun(80, 20, 8))).toHaveLength(0);
  });
});

describe('Rules: пешеходы', () => {
  it('въезд на зебру при пешеходе на проезжей части — нарушение', () => {
    const map = cross({ crosswalkS: true });
    const mon = new RuleMonitor(map);
    const ped: PedView = { x: -1, y: 50, onRoad: true, crosswalk: 0 };
    const vs = drive(mon, northRun(70, 40, 8), { peds: [ped] });
    expect(vs.filter((v) => v === 'pedestrian')).toHaveLength(1);
  });

  it('пешеход на тротуаре — можно ехать', () => {
    const map = cross({ crosswalkS: true });
    const mon = new RuleMonitor(map);
    const ped: PedView = { x: -7, y: 50, onRoad: false, crosswalk: 0 };
    const vs = drive(mon, northRun(70, 40, 8), { peds: [ped] });
    expect(vs).not.toContain('pedestrian');
  });
});

describe('Rules: дорога и столкновения', () => {
  let mon: RuleMonitor;
  beforeEach(() => {
    mon = new RuleMonitor(cross());
  });

  it('съезд с дороги — одно событие на эпизод', () => {
    const off = Array.from({ length: 20 }, () => ({ x: 40, y: 40, heading: E, speed: 3 }));
    const back = Array.from({ length: 10 }, () => ({ x: 2.25, y: 40, heading: N, speed: 3 }));
    const vs = [
      ...drive(mon, off),
      ...drive(mon, back),
      ...drive(mon, off),
    ];
    expect(vs.filter((v) => v === 'off-road')).toHaveLength(2);
  });

  it('столкновение с NPC — одно событие на контакт', () => {
    const npc = actor(2.25, 50, N, 0, 7);
    const touching = Array.from({ length: 10 }, () => ({ x: 2.25, y: 52, heading: N, speed: 2 }));
    const apart = Array.from({ length: 10 }, () => ({ x: 2.25, y: 70, heading: N, speed: 2 }));
    const vs = [
      ...drive(mon, touching, { vehicles: [npc] }),
      ...drive(mon, apart, { vehicles: [npc] }),
      ...drive(mon, touching, { vehicles: [npc] }),
    ];
    expect(vs.filter((v) => v === 'collision')).toHaveLength(2);
  });
});
