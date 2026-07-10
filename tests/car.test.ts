import { describe, it, expect } from 'vitest';
import { Car, type CarInput } from '../src/game/Car';

const DT = 1 / 60;

function run(car: Car, ticks: number, input: Partial<CarInput>): void {
  for (let i = 0; i < ticks; i++) {
    car.update(DT, { throttle: 0, brake: 0, steer: 0, ...input });
  }
}

/** Угол между движением ЗАДНЕЙ ОСИ и осью кузова: без заноса задние
 * колёса катятся вдоль кузова (центр в повороте сносит геометрически). */
function slipAngle(car: Car, input: Partial<CarInput>): number {
  const rearOf = (): { x: number; y: number } => ({
    x: car.position.x - (car.wheelBase / 2) * Math.cos(car.heading),
    y: car.position.y - (car.wheelBase / 2) * Math.sin(car.heading),
  });
  const before = rearOf();
  car.update(DT, { throttle: 0, brake: 0, steer: 0, ...input });
  const after = rearOf();
  const dx = after.x - before.x;
  const dy = after.y - before.y;
  if (Math.hypot(dx, dy) < 1e-6) return 0;
  let d = Math.atan2(dy, dx) - car.heading;
  while (d > Math.PI) d -= 2 * Math.PI;
  while (d < -Math.PI) d += 2 * Math.PI;
  return Math.abs(d);
}

describe('Car physics', () => {
  it('starts at rest at the configured position and heading', () => {
    const car = new Car({ x: 10, y: 20, heading: Math.PI / 2 });
    expect(car.position.x).toBe(10);
    expect(car.position.y).toBe(20);
    expect(car.heading).toBeCloseTo(Math.PI / 2);
    expect(car.velocity).toBe(0);
  });

  it('accelerates forward when throttle is applied', () => {
    const car = new Car({ x: 0, y: 0, heading: 0 });
    for (let i = 0; i < 60; i++) {
      car.update(1 / 60, { throttle: 1, brake: 0, steer: 0 });
    }
    expect(car.velocity).toBeGreaterThan(0);
    expect(car.position.x).toBeGreaterThan(0);
    // heading=0 means we move along +x, so y stays put
    expect(Math.abs(car.position.y)).toBeLessThan(1e-6);
  });

  it('decelerates when brake is applied while moving forward', () => {
    const car = new Car({ x: 0, y: 0, heading: 0 });
    for (let i = 0; i < 60; i++) car.update(1 / 60, { throttle: 1, brake: 0, steer: 0 });
    const speedBefore = car.velocity;
    for (let i = 0; i < 30; i++) car.update(1 / 60, { throttle: 0, brake: 1, steer: 0 });
    expect(car.velocity).toBeLessThan(speedBefore);
  });

  it('caps speed at maxSpeed', () => {
    const car = new Car({ x: 0, y: 0, heading: 0, maxSpeed: 5 });
    for (let i = 0; i < 600; i++) car.update(1 / 60, { throttle: 1, brake: 0, steer: 0 });
    expect(car.velocity).toBeLessThanOrEqual(5 + 1e-6);
  });

  it('turns while moving (steering only affects heading when moving)', () => {
    const stationary = new Car({ x: 0, y: 0, heading: 0 });
    for (let i = 0; i < 30; i++) stationary.update(1 / 60, { throttle: 0, brake: 0, steer: 1 });
    expect(stationary.heading).toBeCloseTo(0);

    const moving = new Car({ x: 0, y: 0, heading: 0 });
    for (let i = 0; i < 60; i++) moving.update(1 / 60, { throttle: 1, brake: 0, steer: 0 });
    const h0 = moving.heading;
    for (let i = 0; i < 60; i++) moving.update(1 / 60, { throttle: 1, brake: 0, steer: 1 });
    expect(moving.heading).not.toBeCloseTo(h0);
  });

  it('reverses when brake is held from rest', () => {
    const car = new Car({ x: 0, y: 0, heading: 0 });
    for (let i = 0; i < 60; i++) car.update(1 / 60, { throttle: 0, brake: 1, steer: 0 });
    expect(car.velocity).toBeLessThan(-0.5);
    expect(car.position.x).toBeLessThan(0);
  });

  it('can accelerate forward out of a reverse', () => {
    const car = new Car({ x: 0, y: 0, heading: 0 });
    for (let i = 0; i < 60; i++) car.update(1 / 60, { throttle: 0, brake: 1, steer: 0 });
    const reverseSpeed = car.velocity;
    for (let i = 0; i < 120; i++) car.update(1 / 60, { throttle: 1, brake: 0, steer: 0 });
    expect(car.velocity).toBeGreaterThan(reverseSpeed);
    expect(car.velocity).toBeGreaterThan(0);
  });

  it('returns 4 OBB corners that reflect length, width, position, and heading', () => {
    const car = new Car({ x: 0, y: 0, heading: 0, length: 4, width: 2 });
    const corners = car.getCorners();
    expect(corners).toHaveLength(4);
    // At heading=0, corners should be at (±2, ±1)
    const xs = corners.map((c) => c.x).sort((a, b) => a - b);
    const ys = corners.map((c) => c.y).sort((a, b) => a - b);
    expect(xs[0]).toBeCloseTo(-2);
    expect(xs[3]).toBeCloseTo(2);
    expect(ys[0]).toBeCloseTo(-1);
    expect(ys[3]).toBeCloseTo(1);
  });

  it('rotates corners with heading', () => {
    const car = new Car({ x: 0, y: 0, heading: Math.PI / 2, length: 4, width: 2 });
    const corners = car.getCorners();
    // At 90°, length now spans y, width spans x
    const xs = corners.map((c) => c.x).sort((a, b) => a - b);
    const ys = corners.map((c) => c.y).sort((a, b) => a - b);
    expect(xs[0]).toBeCloseTo(-1);
    expect(xs[3]).toBeCloseTo(1);
    expect(ys[0]).toBeCloseTo(-2);
    expect(ys[3]).toBeCloseTo(2);
  });

  it('плавный руль: без steerRate угол меняется мгновенно', () => {
    const car = new Car({ x: 0, y: 0, heading: 0 });
    car.update(DT, { throttle: 1, brake: 0, steer: 1 });
    expect(car.steeringAngle).toBeCloseTo(0.6);
  });

  it('плавный руль: со steerRate угол нарастает постепенно', () => {
    const car = new Car({ x: 0, y: 0, heading: 0, steerRate: 2 });
    car.update(DT, { throttle: 1, brake: 0, steer: 1 });
    expect(car.steeringAngle).toBeCloseTo(2 * DT, 5);
    run(car, 60, { throttle: 1, steer: 1 });
    expect(car.steeringAngle).toBeCloseTo(0.6);
    // возврат к нулю тоже ограничен по скорости
    car.update(DT, { throttle: 1, brake: 0, steer: 0 });
    expect(car.steeringAngle).toBeCloseTo(0.6 - 2 * DT, 5);
  });

  it('ручник замедляет быстрее, чем накат', () => {
    const coast = new Car({ x: 0, y: 0, heading: 0 });
    run(coast, 120, { throttle: 1 });
    run(coast, 60, {});
    const hand = new Car({ x: 0, y: 0, heading: 0 });
    run(hand, 120, { throttle: 1 });
    run(hand, 60, { handbrake: 1 });
    expect(hand.velocity).toBeLessThan(coast.velocity - 1.5);
  });

  it('ручник в покое не включает задний ход', () => {
    const car = new Car({ x: 0, y: 0, heading: 0 });
    run(car, 60, { handbrake: 1 });
    expect(Math.abs(car.velocity)).toBeLessThan(1e-6);
    expect(Math.abs(car.position.x)).toBeLessThan(1e-6);
  });

  it('занос: руль + ручник — машину несёт боком', () => {
    const car = new Car({ x: 0, y: 0, heading: 0 });
    run(car, 180, { throttle: 1 });
    run(car, 30, { steer: 1, handbrake: 1 });
    const slip = slipAngle(car, { steer: 1, handbrake: 1 });
    expect(slip).toBeGreaterThan(0.15);
  });

  it('без ручника в повороте заноса нет', () => {
    const car = new Car({ x: 0, y: 0, heading: 0 });
    run(car, 180, { throttle: 1 });
    run(car, 30, { steer: 1 });
    expect(slipAngle(car, { steer: 1 })).toBeLessThan(0.05);
  });

  it('после отпускания ручника скольжение гаснет', () => {
    const car = new Car({ x: 0, y: 0, heading: 0 });
    run(car, 180, { throttle: 1 });
    run(car, 30, { steer: 1, handbrake: 1 });
    run(car, 60, { throttle: 0.5 });
    expect(slipAngle(car, { throttle: 0.5 })).toBeLessThan(0.04);
  });

  it('pivots around the rear axle, not the body center, while steering', () => {
    // Drive a forward arc with full steering; the rear axle's swept radius
    // should be smaller than the body center's — the hallmark of the
    // rear-axle bicycle model (front wheels steer, rear wheels roll straight).
    const car = new Car({ x: 0, y: 0, heading: 0, length: 4, width: 2 });
    const startCenter = { x: car.position.x, y: car.position.y };
    const halfBase = car.wheelBase / 2;
    const startRear = {
      x: startCenter.x - halfBase * Math.cos(car.heading),
      y: startCenter.y - halfBase * Math.sin(car.heading),
    };
    for (let i = 0; i < 240; i++) {
      car.update(1 / 60, { throttle: 1, brake: 0, steer: 1 });
    }
    // Heading has changed (we've been turning)
    expect(car.heading).not.toBeCloseTo(0);

    const endRear = {
      x: car.position.x - halfBase * Math.cos(car.heading),
      y: car.position.y - halfBase * Math.sin(car.heading),
    };
    const rearDist = Math.hypot(endRear.x - startRear.x, endRear.y - startRear.y);
    const centerDist = Math.hypot(car.position.x - startCenter.x, car.position.y - startCenter.y);
    // The body center, sitting outside the rear axle, sweeps a wider arc.
    expect(centerDist).toBeGreaterThan(rearDist);
  });
});
