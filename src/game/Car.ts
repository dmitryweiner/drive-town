import type { OBB } from './Collision';

export interface CarOptions {
  x: number;
  y: number;
  heading: number;
  length?: number;
  width?: number;
  maxSpeed?: number;
}

export interface CarInput {
  throttle: number;
  brake: number;
  steer: number;
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

export class Car {
  position: Vec2;
  heading: number;
  velocity = 0;
  steeringAngle = 0;
  brakeInput = 0;
  readonly length: number;
  readonly width: number;
  readonly wheelBase: number;
  readonly maxSpeed: number;

  constructor(opts: CarOptions) {
    this.position = { x: opts.x, y: opts.y };
    this.heading = opts.heading;
    this.length = opts.length ?? 4;
    this.width = opts.width ?? 2;
    this.wheelBase = this.length * 0.6;
    this.maxSpeed = opts.maxSpeed ?? 15;
  }

  update(dt: number, input: CarInput): void {
    const throttle = clamp(input.throttle, 0, 1);
    const brake = clamp(input.brake, 0, 1);
    const steer = clamp(input.steer, -1, 1);
    this.brakeInput = brake;

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

    if (v > this.maxSpeed) v = this.maxSpeed;
    const minV = -this.maxSpeed * REVERSE_FRAC;
    if (v < minV) v = minV;
    this.velocity = v;

    this.steeringAngle = steer * MAX_STEER;

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
