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

describe('Rules: ЖД-переезд', () => {
  // рельсы на южном луче в 50 м от центра; стоп-линия на y = 52.2
  it('проезд без полной остановки — нарушение', () => {
    const map = cross({ railwayS: true });
    const mon = new RuleMonitor(map);
    const vs = drive(mon, northRun(70, 40, 6));
    expect(vs).toContain('railway');
    expect(vs.filter((v) => v === 'railway')).toHaveLength(1);
  });

  it('с полной остановкой перед переездом — чисто', () => {
    const map = cross({ railwayS: true });
    const mon = new RuleMonitor(map);
    const vs = [
      ...drive(mon, northRun(70, 54, 5)),
      ...drive(mon, Array.from({ length: 20 }, () => ({ x: 2.25, y: 54, heading: N, speed: 0 }))),
      ...drive(mon, northRun(54, 40, 4)),
    ];
    expect(vs).not.toContain('railway');
  });

  // переезд со светофором: мигает красный при t в [0, 10) каждые 34 с
  it('со светофором: проезд на мигающий красный — нарушение', () => {
    const map = cross({ railLightS: true });
    const mon = new RuleMonitor(map);
    // линию (y=52.2) пересекаем на ~3-й секунде мигания — тормозить успевал
    const vs = drive(mon, northRun(70, 40, 6));
    expect(vs).toContain('railway');
  });

  it('со светофором: без мигания останавливаться не нужно', () => {
    const map = cross({ railLightS: true });
    const mon = new RuleMonitor(map);
    const vs = drive(mon, northRun(70, 40, 6), { t0: 12 }); // мигание кончилось на 10 с
    expect(vs).toHaveLength(0);
  });

  it('со светофором: мигание, включившееся в упор, прощается', () => {
    const map = cross({ railLightS: true });
    const mon = new RuleMonitor(map);
    // цикл 34 с: новое мигание с t=34; пересекаем линию на t≈34.1 —
    // остановиться уже нельзя (запас меньше тормозного пути)
    const vs = drive(mon, northRun(76.8, 48, 6), { t0: 30 });
    expect(vs).not.toContain('railway');
  });
});

describe('Rules: знак «разворот запрещён»', () => {
  const uturnPath = (map: ReturnType<typeof cross>) => [
    ...northRun(20, 6, 4),
    ...pathSteps(map.deadEndLoop(0, 2), 3),
    { x: -2.25, y: 12, heading: S, speed: 4 },
    { x: -2.25, y: 20, heading: S, speed: 4 },
  ];

  it('разворот на узле со знаком — нарушение', () => {
    const map = cross({ control: 'none', noUTurn: true });
    const mon = new RuleMonitor(map);
    const vs = drive(mon, uturnPath(map));
    expect(vs).toContain('no-u-turn');
  });

  it('без знака разворот легален', () => {
    const map = cross({ control: 'none' });
    const mon = new RuleMonitor(map);
    const vs = drive(mon, uturnPath(map));
    expect(vs).not.toContain('no-u-turn');
  });

  it('сквозной проезд под знаком — не разворот', () => {
    const map = cross({ control: 'none', noUTurn: true });
    const mon = new RuleMonitor(map);
    const vs = drive(mon, northRun(20, -20, 5));
    expect(vs).not.toContain('no-u-turn');
  });
});

describe('Rules: круговое движение', () => {
  it('въезд на кольцо при машине на кольце — нарушение приоритета', () => {
    const map = cross({ control: 'roundabout' });
    const mon = new RuleMonitor(map);
    // NPC кружит по кольцу: восточная точка осевой, курс на север
    const onRing = actor(6.75, 0, N, 4, 1);
    const vs = drive(mon, northRun(20, 5, 5), { vehicles: [onRing] });
    expect(vs).toContain('priority');
  });

  it('пустое кольцо — проезд чистый', () => {
    const map = cross({ control: 'roundabout' });
    const mon = new RuleMonitor(map);
    // подъезд с юга и «прямо» через кольцо по его траектории
    const vs = [
      ...drive(mon, northRun(20, 9.2, 5)),
      ...drive(mon, pathSteps(map.turnPath(0, 2, 0), 4)),
      ...drive(mon, northRun(-9.5, -20, 5)),
    ];
    expect(vs).toHaveLength(0);
  });

  it('движение по кольцу по часовой (против потока) — «встречка»', () => {
    const map = cross({ control: 'roundabout' });
    const mon = new RuleMonitor(map);
    // круг по осевой кольца ПО часовой стрелке на экране (angle растёт)
    const steps: { x: number; y: number; heading: number; speed: number }[] = [];
    for (let a = Math.PI / 2; a < Math.PI * 2.2; a += 0.04) {
      steps.push({
        x: 6.75 * Math.cos(a),
        y: 6.75 * Math.sin(a),
        heading: a + Math.PI / 2, // касательная в сторону роста угла
        speed: 4,
      });
    }
    expect(drive(mon, steps)).toContain('wrong-way');
  });

  it('движение по кольцу против часовой — чисто', () => {
    const map = cross({ control: 'roundabout' });
    const mon = new RuleMonitor(map);
    const steps: { x: number; y: number; heading: number; speed: number }[] = [];
    for (let a = Math.PI / 2; a > -Math.PI * 1.7; a -= 0.04) {
      steps.push({
        x: 6.75 * Math.cos(a),
        y: 6.75 * Math.sin(a),
        heading: a - Math.PI / 2, // касательная в сторону убывания угла
        speed: 4,
      });
    }
    expect(drive(mon, steps)).not.toContain('wrong-way');
  });

  it('на кольце нет правила «левый под встречного»', () => {
    const map = cross({ control: 'roundabout' });
    const mon = new RuleMonitor(map);
    // встречный подъезжает с севера, а мы уходим с юга налево (на запад)
    const oncoming = actor(-2.25, -10, S, 8, 1);
    const path = pathSteps(map.turnPath(0, 2, 3), 4);
    const vs = [
      ...drive(mon, northRun(20, 6, 4)),
      ...drive(mon, path, { vehicles: [oncoming] }),
      ...drive(mon, [{ x: -12, y: -2.25, heading: W, speed: 4 }], { vehicles: [oncoming] }),
    ];
    expect(vs).not.toContain('priority');
  });
});

/** Шаги вдоль полилинии с курсом по сегментам. */
function pathSteps(pts: { x: number; y: number }[], speed: number): { x: number; y: number; heading: number; speed: number }[] {
  const out: { x: number; y: number; heading: number; speed: number }[] = [];
  const step = speed * 0.05;
  for (let i = 1; i < pts.length; i++) {
    const dx = pts[i].x - pts[i - 1].x;
    const dy = pts[i].y - pts[i - 1].y;
    const len = Math.hypot(dx, dy);
    const heading = Math.atan2(dy, dx);
    for (let s = 0; s < len; s += step) {
      out.push({ x: pts[i - 1].x + (dx * s) / len, y: pts[i - 1].y + (dy * s) / len, heading, speed });
    }
  }
  return out;
}

describe('Rules: приоритет', () => {
  it('выезд со второстепенной под машину на главной — нарушение', () => {
    const map = cross({ control: 'priority', mainAxis: 'h', minorSign: 'yield' });
    const mon = new RuleMonitor(map);
    // NPC по главной с востока, едет на запад, в 7 м до стоп-линии
    const npc = actor(12.5, -2.25, W, 7, 1);
    const vs = drive(mon, northRun(20, -2, 6), { vehicles: [npc] });
    expect(vs).toContain('priority');
  });

  it('одновременный въезд с непересекающимися траекториями легален', () => {
    const map = cross({ control: 'priority', mainAxis: 'h', minorSign: 'yield' });
    const mon = new RuleMonitor(map);
    // машина уже в квадрате, уходит направо на запад по своей полосе —
    // наш путь прямо на север её не пересекает (кейс с двух второстепенных)
    const leaving = actor(-2, -1.5, W, 4, 1);
    const vs = drive(mon, northRun(20, -8, 5), { vehicles: [leaving] });
    expect(vs).not.toContain('priority');
  });

  it('машина в квадрате поперёк нашего пути — «не уступил»', () => {
    const map = cross({ control: 'priority', mainAxis: 'h', minorSign: 'yield' });
    const mon = new RuleMonitor(map);
    // пересекает квадрат на восток по нашей стороне — траектории сходятся
    const crossing = actor(-3, 2.25, E, 5, 1);
    const vs = drive(mon, northRun(20, -8, 5), { vehicles: [crossing] });
    expect(vs).toContain('priority');
  });

  it('попутный лидер в квадрате впереди — не «не уступил»', () => {
    const map = cross({ control: 'none' });
    const mon = new RuleMonitor(map);
    // едет прямо перед нами через перекрёсток в ту же сторону
    const leader = actor(2.25, -2, N, 5, 1);
    const vs = drive(mon, northRun(9, -8, 5), { vehicles: [leader] });
    expect(vs).not.toContain('priority');
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

describe('Rules: поворот в свою полосу (односторонка)', () => {
  // e1 (на восток) односторонняя: две полосы восточного направления.
  // ПДД Израиля: тк. 42 — правый поворот завершается в правой полосе,
  // тк. 43 — левый на односторонку — в левой.
  function southRun(y0: number, y1: number, x: number, speed: number): { x: number; y: number; heading: number; speed: number }[] {
    const steps: { x: number; y: number; heading: number; speed: number }[] = [];
    for (let y = y0; y <= y1; y += speed * 0.05) steps.push({ x, y, heading: S, speed });
    return steps;
  }
  function eastRun(x0: number, x1: number, y: number, speed: number): { x: number; y: number; heading: number; speed: number }[] {
    const steps: { x: number; y: number; heading: number; speed: number }[] = [];
    for (let x = x0; x <= x1; x += speed * 0.05) steps.push({ x, y, heading: E, speed });
    return steps;
  }

  it('левый поворот в правую (дальнюю) полосу — нарушение', () => {
    const map = cross({ oneWayE: true });
    const mon = new RuleMonitor(map);
    const steps = [
      ...southRun(-20, -6, -2.25, 5),
      { x: -2, y: -3.5, heading: 1.2, speed: 4 },
      { x: -1, y: -1.5, heading: 0.9, speed: 4 },
      { x: 0.5, y: 0.2, heading: 0.6, speed: 4 },
      { x: 2.5, y: 1.5, heading: 0.3, speed: 4 },
      { x: 4.4, y: 2.1, heading: 0.1, speed: 4 },
      ...eastRun(6, 25, 2.25, 5),
    ];
    const vs = drive(mon, steps);
    expect(vs.filter((v) => v === 'turn-lane')).toHaveLength(1);
  });

  it('левый поворот в левую полосу (по turnPath) — чисто', () => {
    const map = cross({ oneWayE: true });
    const mon = new RuleMonitor(map);
    const vs = drive(mon, [
      ...southRun(-20, -8, -2.25, 5),
      ...pathSteps(map.turnPath(0, 0, 1), 4),
      ...eastRun(6, 25, -2.25, 5),
    ]);
    expect(vs).not.toContain('turn-lane');
    expect(vs).not.toContain('wrong-way');
  });

  it('правый поворот в левую (дальнюю) полосу — нарушение', () => {
    const map = cross({ oneWayE: true });
    const mon = new RuleMonitor(map);
    const steps = [
      ...northRun(20, 6, 5),
      { x: 2.5, y: 3, heading: -1.1, speed: 4 },
      { x: 3.5, y: 0.5, heading: -0.7, speed: 4 },
      { x: 4.4, y: -1.2, heading: -0.35, speed: 4 },
      ...eastRun(6, 25, -2.25, 5),
    ];
    const vs = drive(mon, steps);
    expect(vs.filter((v) => v === 'turn-lane')).toHaveLength(1);
  });

  it('правый поворот в правую полосу (по turnPath) — чисто', () => {
    const map = cross({ oneWayE: true });
    const mon = new RuleMonitor(map);
    const vs = drive(mon, [
      ...northRun(20, 8, 5),
      ...pathSteps(map.turnPath(0, 2, 1), 4),
      ...eastRun(6, 25, 2.25, 5),
    ]);
    expect(vs).not.toContain('turn-lane');
  });

  it('на двусторонней выезд в свою полосу не судится', () => {
    const map = cross();
    const mon = new RuleMonitor(map);
    const steps = [
      ...southRun(-20, -6, -2.25, 5),
      { x: -2, y: -3.5, heading: 1.2, speed: 4 },
      { x: -1, y: -1.5, heading: 0.9, speed: 4 },
      { x: 0.5, y: 0.2, heading: 0.6, speed: 4 },
      { x: 2.5, y: 1.5, heading: 0.3, speed: 4 },
      { x: 4.4, y: 2.1, heading: 0.1, speed: 4 },
      ...eastRun(6, 25, 2.25, 5),
    ];
    expect(drive(mon, steps)).not.toContain('turn-lane');
  });

  it('выезд с кольца на односторонку правой полосой — не нарушение', () => {
    const map = cross({ control: 'roundabout', oneWayE: true });
    const mon = new RuleMonitor(map);
    // с севера через кольцо на восток: ringPath выводит в правую полосу
    const vs = drive(mon, [
      ...southRun(-20, -9.5, -2.25, 5),
      ...pathSteps(map.turnPath(0, 0, 1), 4),
      ...eastRun(10, 30, 2.25, 5),
    ]);
    expect(vs).not.toContain('turn-lane');
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
