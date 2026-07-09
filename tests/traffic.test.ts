import { describe, expect, it } from 'vitest';
import { obbIntersect, type OBB } from '../src/game/Collision';
import { HALF_ROAD, STOP_LINE_OFFSET } from '../src/game/CityMap';
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
