import type { OBB } from './Collision';

export interface CarOptions {
  x: number;
  y: number;
  heading: number;
  length?: number;
  width?: number;
  maxSpeed?: number;
  /** Скорость поворота руля, рад/с. По умолчанию мгновенный руль
   * (историческое поведение parking-game/driving-trainer). */
  steerRate?: number;
}

export interface CarInput {
  throttle: number;
  brake: number;
  steer: number;
  /** Ручной тормоз: блокирует задние колёса — торможение + занос. */
  handbrake?: number;
}

export interface Vec2 {
  x: number;
  y: number;
}

const MAX_STEER = 0.6;
const ACCEL = 6;
const BRAKE = 10;
const DRAG = 0.5;
const REVERSE_FRAC = 0.5;
/** Торможение ручником, м/с². */
const HANDBRAKE_DECEL = 8;
/** Ручник усиливает вращение кузова (корму срывает). */
const DRIFT_YAW_GAIN = 0.6;
/** Гашение бокового скольжения, 1/с: на ручнике колёса скользят,
 * после отпускания сцепление быстро возвращается. */
const GRIP_DRIFT = 1.6;
const GRIP_RECOVER = 5;

export class Car {
  position: Vec2;
  heading: number;
  velocity = 0;
  /** Боковая скорость кузова (занос), м/с; >0 — вправо от оси. */
  lateralV = 0;
  steeringAngle = 0;
  brakeInput = 0;
  handbrakeInput = 0;
  readonly length: number;
  readonly width: number;
  readonly wheelBase: number;
  readonly maxSpeed: number;
  readonly steerRate: number;

  constructor(opts: CarOptions) {
    this.position = { x: opts.x, y: opts.y };
    this.heading = opts.heading;
    this.length = opts.length ?? 4;
    this.width = opts.width ?? 2;
    this.wheelBase = this.length * 0.6;
    this.maxSpeed = opts.maxSpeed ?? 15;
    this.steerRate = opts.steerRate ?? Infinity;
  }

  update(dt: number, input: CarInput): void {
    const throttle = clamp(input.throttle, 0, 1);
    const brake = clamp(input.brake, 0, 1);
    const steer = clamp(input.steer, -1, 1);
    const handbrake = clamp(input.handbrake ?? 0, 0, 1);
    this.brakeInput = brake;
    this.handbrakeInput = handbrake;

    const oldV = this.velocity;

    // throttle accelerates forward; if already reversing it first brakes the reverse
    let accelForce = 0;
    if (throttle > 0) {
      accelForce = oldV >= 0 ? throttle * ACCEL : throttle * BRAKE;
    }
    // brake decelerates forward motion; near rest or already reversing, it engages reverse
    let brakeForce = 0;
    if (brake > 0) {
      brakeForce = oldV > 0.5 ? brake * BRAKE : brake * ACCEL;
    }
    const drag = DRAG * oldV;
    let v = oldV + (accelForce - brakeForce - drag) * dt;

    // ручник тормозит к нулю, но никогда не «включает задний ход»
    if (handbrake > 0) {
      const dec = HANDBRAKE_DECEL * handbrake * dt;
      if (v > 0) v = Math.max(0, v - dec);
      else if (v < 0) v = Math.min(0, v + dec);
    }

    if (v > this.maxSpeed) v = this.maxSpeed;
    const minV = -this.maxSpeed * REVERSE_FRAC;
    if (v < minV) v = minV;
    this.velocity = v;

    // руль: мгновенный (steerRate = Infinity) или с ограниченной скоростью
    const targetSteer = steer * MAX_STEER;
    if (this.steerRate === Infinity) {
      this.steeringAngle = targetSteer;
    } else {
      const maxDelta = this.steerRate * dt;
      this.steeringAngle += clamp(targetSteer - this.steeringAngle, -maxDelta, maxDelta);
    }

    const drifting = handbrake > 0 || Math.abs(this.lateralV) > 0.02;
    if (!drifting) {
      // Rear-axle bicycle model: only the front wheels steer, so the rear axle
      // rolls straight along the car's heading and the body rotates around the
      // external instant center (perpendicular to the rear axle, R = L/tan δ).
      // Track the rear axle as the kinematic reference; re-derive the body
      // center after the heading update so the body sweeps outward correctly.
      const halfBase = this.wheelBase / 2;
      const cosH = Math.cos(this.heading);
      const sinH = Math.sin(this.heading);
      const rearX = this.position.x - halfBase * cosH;
      const rearY = this.position.y - halfBase * sinH;
      const newRearX = rearX + v * cosH * dt;
      const newRearY = rearY + v * sinH * dt;

      const yawRate = (v / this.wheelBase) * Math.tan(this.steeringAngle);
      this.heading += yawRate * dt;

      this.position.x = newRearX + halfBase * Math.cos(this.heading);
      this.position.y = newRearY + halfBase * Math.sin(this.heading);
      return;
    }

    // Занос: кузов вращается, а вектор скорости сохраняется по инерции —
    // его локальные компоненты (вдоль/поперёк оси) перераспределяются,
    // и боковая часть гасится сцеплением (слабым, пока ручник затянут).
    const yawRate = (v / this.wheelBase) * Math.tan(this.steeringAngle) * (1 + DRIFT_YAW_GAIN * handbrake);
    const dH = yawRate * dt;
    this.heading += dH;
    const cosD = Math.cos(dH);
    const sinD = Math.sin(dH);
    const vLong = v * cosD + this.lateralV * sinD;
    let vLat = this.lateralV * cosD - v * sinD;
    const grip = handbrake > 0 ? GRIP_DRIFT : GRIP_RECOVER;
    vLat *= Math.exp(-grip * dt);
    if (handbrake === 0 && Math.abs(vLat) < 0.02) vLat = 0;
    this.velocity = clamp(vLong, -this.maxSpeed, this.maxSpeed);
    this.lateralV = vLat;

    const cosH = Math.cos(this.heading);
    const sinH = Math.sin(this.heading);
    this.position.x += (cosH * this.velocity - sinH * vLat) * dt;
    this.position.y += (sinH * this.velocity + cosH * vLat) * dt;
  }

  getCorners(): Vec2[] {
    const hl = this.length / 2;
    const hw = this.width / 2;
    const cos = Math.cos(this.heading);
    const sin = Math.sin(this.heading);
    const local: Vec2[] = [
      { x: hl, y: -hw },
      { x: hl, y: hw },
      { x: -hl, y: hw },
      { x: -hl, y: -hw },
    ];
    return local.map((p) => ({
      x: this.position.x + p.x * cos - p.y * sin,
      y: this.position.y + p.x * sin + p.y * cos,
    }));
  }

  getOBB(): OBB {
    return {
      cx: this.position.x,
      cy: this.position.y,
      hx: this.length / 2,
      hy: this.width / 2,
      angle: this.heading,
    };
  }
}

function clamp(v: number, a: number, b: number): number {
  return Math.max(a, Math.min(b, v));
}
