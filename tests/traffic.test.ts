import { describe, expect, it } from 'vitest';
import { obbIntersect, type OBB } from '../src/game/Collision';
import { CityMap, HALF_ROAD, ROUNDABOUT_R, STOP_LINE_OFFSET } from '../src/game/CityMap';
import { mulberry32 } from '../src/game/rng';
import { Traffic } from '../src/game/Traffic';
import type { ActorView } from '../src/game/Rules';
import { cross } from './helpers/fixtures';

const DT = 0.05;

function viewOBB(v: { x: number; y: number; heading: number; length: number; width: number }): OBB {
  return { cx: v.x, cy: v.y, hx: v.length / 2, hy: v.width / 2, angle: v.heading };
}

describe('Traffic: движение по дорогам', () => {
  it('машины остаются на полотне и не превышают свой максимум', () => {
    const map = cross();
    const tr = new Traffic(map, mulberry32(1), {
      vehicles: [
        { kind: 'car', edge: 2, dirSign: 1, along: 20 },
        { kind: 'bicycle', edge: 1, dirSign: 1, along: 30 },
        { kind: 'motorcycle', edge: 3, dirSign: 1, along: 20 },
      ],
    });
    const moved = [0, 0, 0];
    let prev = tr.vehicleViews().map((v) => ({ x: v.x, y: v.y }));
    for (let t = 0; t < 40; t += DT) {
      tr.update(DT, t, null);
      const views = tr.vehicleViews();
      views.forEach((v, i) => {
        expect(map.isOnRoad({ x: v.x, y: v.y }), `NPC ${i} слетел с дороги: ${v.x},${v.y}`).toBe(true);
        expect(Math.abs(v.speed)).toBeLessThanOrEqual(12.01);
        moved[i] += Math.hypot(v.x - prev[i].x, v.y - prev[i].y);
      });
      prev = views.map((v) => ({ x: v.x, y: v.y }));
    }
    // никто не застрял навечно
    for (const m of moved) expect(m).toBeGreaterThan(20);
  });

  it('детерминизм по seed', () => {
    const run = (): string => {
      const map = cross();
      const tr = Traffic.random(map, mulberry32(5), 5, []);
      for (let t = 0; t < 10; t += DT) tr.update(DT, t, null);
      return JSON.stringify(tr.vehicleViews());
    };
    expect(run()).toBe(run());
  });
});

describe('Traffic: светофор', () => {
  it('NPC стоит на красный и едет на зелёный', () => {
    const map = cross({ control: 'lights' });
    // подъезд с запада: красный при t в [0,9)
    const tr = new Traffic(map, mulberry32(2), {
      vehicles: [{ kind: 'car', edge: 3, dirSign: 1, along: 60 }],
    });
    const stopX = -HALF_ROAD - STOP_LINE_OFFSET; // -5.5
    let crossedAt = -1;
    for (let t = 0; t < 16; t += DT) {
      tr.update(DT, t, null);
      const v = tr.vehicleViews()[0];
      const frontX = v.x + v.length / 2;
      const light = map.lightState(0, 'W', t);
      if (light === 'red' || light === 'red-yellow') {
        expect(frontX, `бампер за стоп-линией на красный (t=${t.toFixed(2)})`).toBeLessThanOrEqual(stopX + 0.3);
      }
      // «поехал» = бампер пересёк стоп-линию (выезд может быть в любую сторону)
      if (crossedAt < 0 && frontX > stopX + 0.5) crossedAt = t;
    }
    expect(crossedAt).toBeGreaterThan(9);
    expect(crossedAt).toBeLessThan(16);
  });

  it('жёлтый, заставший NPC за стоп-линией, не бросает его посреди проезда', () => {
    // прямая улица W→E с светофором в центре; жёлтый для подъезда W
    // включается на t=1.4 — бампер NPC пересекает линию ещё на зелёный,
    // центр — уже на жёлтый. Раньше NPC мгновенно замирал носом в квадрате
    // до следующего зелёного и запирал перекрёсток взаимным «после вас»
    // (клинч на сиде 369989378): манёвр, начатый с разрешением, надо ДОВОДИТЬ.
    const map = new CityMap({
      nodes: [
        { x: 0, y: 0, control: 'lights', lightOffset: 16.6 },
        { x: -100, y: 0 },
        { x: 100, y: 0 },
      ],
      edges: [
        { a: 1, b: 0 },
        { a: 0, b: 2 },
      ],
    });
    const tr = new Traffic(map, mulberry32(2), {
      vehicles: [{ kind: 'car', edge: 0, dirSign: 1, along: 92 }],
    });
    const stopX = -HALF_ROAD - STOP_LINE_OFFSET; // -5.5
    let frozenPastLine = false;
    let crossed = false;
    for (let t = 0; t < 12; t += DT) {
      tr.update(DT, t, null);
      const v = tr.vehicleViews()[0];
      const frontX = v.x + v.length / 2;
      if (Math.abs(v.speed) < 0.05 && frontX > stopX + 0.2 && v.x < HALF_ROAD) frozenPastLine = true;
      if (v.x > HALF_ROAD + 2) crossed = true;
    }
    expect(frozenPastLine, 'NPC замер за стоп-линией').toBe(false);
    expect(crossed, 'NPC не завершил проезд').toBe(true);
  });
});

describe('Traffic: знак «стоп» и приоритет', () => {
  it('NPC на второстепенной полностью останавливается перед «стоп»', () => {
    const map = cross({ control: 'priority', mainAxis: 'h', minorSign: 'stop' });
    const tr = new Traffic(map, mulberry32(3), {
      vehicles: [{ kind: 'car', edge: 2, dirSign: -1, along: 40 }], // с юга к центру
    });
    let fullStopInZone = false;
    let crossed = false;
    for (let t = 0; t < 25; t += DT) {
      tr.update(DT, t, null);
      const v = tr.vehicleViews()[0];
      if (Math.abs(v.speed) < 0.05 && v.y > HALF_ROAD && v.y < 14) fullStopInZone = true;
      if (v.y < -HALF_ROAD || Math.abs(v.x) > HALF_ROAD) crossed = true;
    }
    expect(fullStopInZone).toBe(true);
    expect(crossed).toBe(true);
  });

  it('NPC уступает игроку на главной', () => {
    const map = cross({ control: 'priority', mainAxis: 'h', minorSign: 'yield' });
    const tr = new Traffic(map, mulberry32(4), {
      vehicles: [{ kind: 'car', edge: 2, dirSign: -1, along: 40 }],
    });
    for (let t = 0; t < 20; t += DT) {
      // игрок едет по главной с востока на запад
      const px = 60 - 8 * t;
      const player: ActorView = { id: -1, x: px, y: -2.25, heading: Math.PI, speed: 8, length: 4, width: 2 };
      tr.update(DT, t, player);
      const v = tr.vehicleViews()[0];
      // пока игрок в квадрате перекрёстка или близко к нему — NPC не въезжает
      expect(obbIntersect(viewOBB(v), viewOBB(player)), `столкновение с игроком (t=${t.toFixed(2)})`).toBe(false);
      // пока игрок подъезжает или в квадрате — NPC не суётся;
      // когда игрок уже покинул перекрёсток, NPC может ехать
      if (px < 12 && px > -6) {
        expect(v.y, `NPC въехал под игрока (t=${t.toFixed(2)})`).toBeGreaterThan(HALF_ROAD - 0.5);
      }
    }
  });

  it('на нерегулируемом перекрёстке NPC не сталкиваются', () => {
    const map = cross({ control: 'none' });
    const tr = new Traffic(map, mulberry32(6), {
      vehicles: [
        { kind: 'car', edge: 2, dirSign: -1, along: 40 },  // с юга
        { kind: 'car', edge: 1, dirSign: -1, along: 40 },  // с востока
      ],
    });
    let bothCrossed = false;
    for (let t = 0; t < 40; t += DT) {
      tr.update(DT, t, null);
      const [a, b] = tr.vehicleViews();
      expect(obbIntersect(viewOBB(a), viewOBB(b)), `NPC столкнулись (t=${t.toFixed(2)})`).toBe(false);
      const aOut = Math.hypot(a.x, a.y) > 20;
      const bOut = Math.hypot(b.x, b.y) > 20;
      if (aOut && bOut) bothCrossed = true;
    }
    expect(bothCrossed).toBe(true);
  });
});

describe('Traffic: ЖД-переезд', () => {
  it('NPC полностью останавливается перед переездом и потом проезжает', () => {
    const map = cross({ railwayS: true }); // рельсы на e2, 50 м от центра
    const tr = new Traffic(map, mulberry32(9), {
      vehicles: [{ kind: 'car', edge: 2, dirSign: 1, along: 20 }],
    });
    let minNearLine = Infinity;
    let maxAlong = 0;
    for (let t = 0; t < 30; t += DT) {
      tr.update(DT, t, null);
      const v = tr.vehicleViews()[0];
      // едет на юг по e2: along ≈ y; стоп-линия на y = 47.8
      if (v.y > 43 && v.y < 48.5) minNearLine = Math.min(minNearLine, Math.abs(v.speed));
      maxAlong = Math.max(maxAlong, v.y);
    }
    expect(minNearLine).toBeLessThan(0.08); // полная остановка в стоп-зоне
    expect(maxAlong).toBeGreaterThan(60);   // и поехал дальше через рельсы
  });

  it('у переезда со светофором NPC стоит при мигании и едет без остановки после', () => {
    const map = cross({ railLightS: true }); // мигает при t в [0, 10)
    const tr = new Traffic(map, mulberry32(9), {
      vehicles: [{ kind: 'car', edge: 2, dirSign: 1, along: 20 }],
    });
    let crossedAt = -1;
    for (let t = 0; t < 25; t += DT) {
      tr.update(DT, t, null);
      const v = tr.vehicleViews()[0];
      const front = v.y + v.length / 2;
      // пока мигает — бампер не пересекает линию рельсов (y = 48.8)
      if (map.railFlashing(0, t) && t > 5) {
        expect(front, `NPC на переезде при мигании (t=${t.toFixed(2)})`).toBeLessThan(49);
      }
      if (crossedAt < 0 && v.y > 52) crossedAt = t;
    }
    // после конца мигания (10 с) проезжает без полной остановки
    expect(crossedAt).toBeGreaterThan(10);
    expect(crossedAt).toBeLessThan(14);
  });
});

describe('Traffic: круговое движение', () => {
  it('NPC проезжает кольцо, оставаясь на полотне и объезжая островок', () => {
    const map = cross({ control: 'roundabout' });
    const tr = new Traffic(map, mulberry32(11), {
      vehicles: [{ kind: 'car', edge: 0, dirSign: 1, along: 40 }],
    });
    let wasInRing = false;
    let leftRing = false;
    for (let t = 0; t < 60; t += DT) {
      tr.update(DT, t, null);
      const v = tr.vehicleViews()[0];
      const d = Math.hypot(v.x, v.y);
      expect(map.isOnRoad({ x: v.x, y: v.y }), `NPC вне дороги: ${v.x},${v.y}`).toBe(true);
      if (d < 8) wasInRing = true;
      if (wasInRing && d > 14) leftRing = true;
    }
    expect(wasInRing).toBe(true);
    expect(leftRing).toBe(true);
  });

  it('NPC не въезжает на занятое кольцо', () => {
    const map = cross({ control: 'roundabout' });
    const tr = new Traffic(map, mulberry32(12), {
      vehicles: [{ kind: 'car', edge: 0, dirSign: 1, along: 80 }],
    });
    // игрок «кружит» по кольцу: точка на осевой кольца с ненулевой скоростью
    const player: ActorView = { id: -1, x: 6.75, y: 0, heading: -Math.PI / 2, speed: 4, length: 4, width: 2 };
    for (let t = 0; t < 12; t += DT) tr.update(DT, t, player);
    const v = tr.vehicleViews()[0];
    // NPC добрался к кольцу, но внутрь не сунулся
    expect(Math.hypot(v.x, v.y)).toBeGreaterThan(ROUNDABOUT_R);
  });
});

describe('Traffic: клаксон (детекция всегда активна, звук — дело UI)', () => {
  const S = Math.PI / 2; // курс на юг
  const player = (x: number, y: number, heading: number, speed: number): ActorView =>
    ({ id: -1, x, y, heading, speed, length: 4, width: 2 });

  it('«блокировка»: NPC стоит за игроком ≥3 с — гудок, повтор через 4 с, серия растёт', () => {
    const map = cross();
    const tr = new Traffic(map, mulberry32(1), {
      vehicles: [{ kind: 'car', edge: 2, dirSign: 1, along: 20 }], // едет на юг
    });
    const p = player(-2.25, 50, S, 0); // стоит на его полосе
    const honks: { t: number; kind: string; n: number }[] = [];
    for (let t = 0; t < 20; t += DT) {
      tr.update(DT, t, p);
      for (const h of tr.consumeHonks()) honks.push({ t, kind: h.kind, n: h.n });
    }
    expect(honks.length).toBeGreaterThanOrEqual(2);
    expect(honks.every((h) => h.kind === 'blocked')).toBe(true);
    // подъехать + постоять 3 с: раньше ~6 с гудка быть не может
    expect(honks[0].t).toBeGreaterThan(6);
    // повтор через 4 + id % 3 = 4 с (± тик симуляции), номер в серии растёт
    expect(honks[1].t - honks[0].t).toBeCloseTo(4, 0);
    expect(honks.map((h) => h.n)).toEqual(honks.map((_, i) => i + 1));
  });

  it('«блокировка» не гудит, пока свет NPC красный (очередь на светофоре)', () => {
    const map = cross({ control: 'lights' });
    // западный подъезд: горизонтали зелёный только при t в [10,18)
    const tr = new Traffic(map, mulberry32(2), {
      vehicles: [{ kind: 'car', edge: 3, dirSign: 1, along: 75 }],
    });
    const p = player(-10, 2.25, 0, 0); // стоит перед стоп-линией
    const honks: number[] = [];
    for (let t = 0; t < 17; t += DT) {
      tr.update(DT, t, p);
      for (const h of tr.consumeHonks()) {
        expect(h.kind).toBe('blocked');
        honks.push(t);
      }
    }
    // на красный молчит, хотя стоит за игроком с ~3 с; гудок — через 3 с зелёного
    expect(honks.length).toBeGreaterThanOrEqual(1);
    expect(honks[0]).toBeGreaterThan(12.5);
    expect(honks[0]).toBeLessThan(14);
  });

  it('«подрезание»: игрок возник близко перед движущимся NPC — одиночный гудок, латч', () => {
    const map = cross();
    const tr = new Traffic(map, mulberry32(1), {
      vehicles: [{ kind: 'car', edge: 2, dirSign: 1, along: 10 }],
    });
    let t = 0;
    for (; t < 3; t += DT) {
      tr.update(DT, t, null);
      tr.consumeHonks();
    }
    const v0 = tr.vehicleViews()[0];
    expect(Math.abs(v0.speed)).toBeGreaterThan(7); // разогнался
    // игрок вклинивается в 8 м перед носом и едет медленно
    let py = v0.y + 8;
    const honks: { t: number; kind: string }[] = [];
    for (const tCut = t; t < tCut + 5; t += DT) {
      tr.update(DT, t, player(-2.25, py, S, 3));
      py += 3 * DT;
      for (const h of tr.consumeHonks()) honks.push({ t, kind: h.kind });
    }
    expect(honks).toHaveLength(1);
    expect(honks[0].kind).toBe('cutoff');
    expect(honks[0].t).toBeLessThan(3.3); // сразу, не по таймеру
  });

  it('обычное сближение с едущим впереди игроком — без гудков', () => {
    const map = cross();
    const tr = new Traffic(map, mulberry32(1), {
      vehicles: [{ kind: 'car', edge: 2, dirSign: 1, along: 10 }],
    });
    let py = 40;
    let honks = 0;
    for (let t = 0; t < 10; t += DT) {
      tr.update(DT, t, player(-2.25, py, S, 3));
      py += 3 * DT;
      honks += tr.consumeHonks().length;
    }
    expect(honks).toBe(0);
  });
});

describe('Traffic: полоса при повороте на односторонку', () => {
  it('левый поворот: NPC выезжает в левую полосу и перестраивается вправо', () => {
    // Т-образный тупик маршрута: с севера можно только налево на восточную
    // односторонку — тк. 43 требует выезда в ЛЕВУЮ полосу
    const map = new CityMap({
      nodes: [{ x: 0, y: 0 }, { x: 0, y: -100 }, { x: 100, y: 0 }],
      edges: [
        { a: 1, b: 0 },
        { a: 0, b: 2, oneWay: true },
      ],
    });
    const tr = new Traffic(map, mulberry32(1), {
      vehicles: [{ kind: 'car', edge: 0, dirSign: 1, along: 60 }],
    });
    let sawLeftLane = false;
    let mergedBack = false;
    for (let t = 0; t < 30; t += DT) {
      tr.update(DT, t, null);
      const v = tr.vehicleViews()[0];
      expect(map.isOnRoad({ x: v.x, y: v.y }), `NPC вне дороги: ${v.x},${v.y}`).toBe(true);
      if (v.x > 5 && v.x < 9 && v.y < -1) sawLeftLane = true;
      if (v.x > 45) {
        mergedBack = true;
        expect(v.y, `не перестроился вправо (x=${v.x.toFixed(1)})`).toBeCloseTo(2.25, 1);
      }
    }
    expect(sawLeftLane, 'NPC не вышел в левую полосу').toBe(true);
    expect(mergedBack).toBe(true);
  });
});

describe('Traffic: дистанция и пешеходы', () => {
  it('машина не таранит медленный велосипед впереди', () => {
    const map = cross();
    const tr = new Traffic(map, mulberry32(7), {
      vehicles: [
        { kind: 'bicycle', edge: 2, dirSign: 1, along: 50 },
        { kind: 'car', edge: 2, dirSign: 1, along: 20 },
      ],
    });
    for (let t = 0; t < 10; t += DT) {
      tr.update(DT, t, null);
      const [bike, car] = tr.vehicleViews();
      expect(obbIntersect(viewOBB(bike), viewOBB(car)), `догнал велосипед (t=${t.toFixed(2)})`).toBe(false);
    }
  });

  it('NPC пропускает пешехода на зебре', () => {
    const map = cross({ crosswalkS: true });
    const tr = new Traffic(map, mulberry32(8), {
      vehicles: [{ kind: 'car', edge: 2, dirSign: -1, along: 85 }], // с юга на север
      peds: [{ crosswalk: 0, delay: 0 }],
    });
    const cw = map.crosswalks()[0];
    let pedWasOnRoad = false;
    let carPassed = false;
    for (let t = 0; t < 30; t += DT) {
      tr.update(DT, t, null);
      const v = tr.vehicleViews()[0];
      const peds = tr.pedViews();
      const pedOn = peds.some((p) => p.crosswalk === 0 && p.onRoad);
      if (pedOn) {
        pedWasOnRoad = true;
        const zebra: OBB = {
          cx: (cw.rect.xMin + cw.rect.xMax) / 2,
          cy: (cw.rect.yMin + cw.rect.yMax) / 2,
          hx: (cw.rect.xMax - cw.rect.xMin) / 2,
          hy: (cw.rect.yMax - cw.rect.yMin) / 2,
          angle: 0,
        };
        expect(obbIntersect(viewOBB(v), zebra), `NPC на зебре при пешеходе (t=${t.toFixed(2)})`).toBe(false);
      }
      if (v.y < 40) carPassed = true;
    }
    expect(pedWasOnRoad).toBe(true);
    expect(carPassed).toBe(true);
  });
});
