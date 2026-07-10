import { Car, type CarInput } from './Car';
import { obbIntersect } from './Collision';
import { rectToOBBRect } from './CityMap';
import { GOAL_RADIUS, type Level } from './generate';
import { RuleMonitor, type ActorView } from './Rules';
import { mulberry32 } from './rng';
import { Traffic } from './Traffic';
import type { Violation } from './types';

/** «Эталонная» средняя скорость для par-времени, м/с. */
export const PAR_SPEED = 7;
export const BASE_SCORE = 1000;
export const VIOLATION_PENALTY = 150;
/** Машин NPC на уровне. */
export const TRAFFIC_COUNT = 18;

/** Очки за уровень: чистый и быстрый проезд = BASE_SCORE; время сверх
 * par-времени срезает пропорционально, каждое нарушение — фикс. штраф. */
export function computeScore(parSec: number, timeSec: number, violations: number): number {
  const timeFactor = parSec / Math.max(timeSec, parSec);
  return Math.max(0, Math.round(BASE_SCORE * timeFactor) - VIOLATION_PENALTY * violations);
}

/** Один раунд: уровень, машина игрока, трафик, правила, цель, очки. */
export class Round {
  readonly plan: Level;
  readonly car: Car;
  readonly traffic: Traffic;
  private readonly rules: RuleMonitor;
  time = 0;
  violations: Violation[] = [];
  finished = false;
  score = 0;

  constructor(plan: Level, opts: { trafficCount?: number } = {}) {
    this.plan = plan;
    // steerRate: руль с ограниченной скоростью — мягче реагирует на стрелки
    this.car = new Car({ x: plan.spawn.x, y: plan.spawn.y, heading: plan.spawn.heading, steerRate: 2.8 });
    this.rules = new RuleMonitor(plan.map);
    const count = opts.trafficCount ?? TRAFFIC_COUNT;
    this.traffic = Traffic.random(plan.map, mulberry32(plan.seed * 7919 + 17), count, [
      { x: plan.spawn.x, y: plan.spawn.y },
      plan.goal,
    ]);
  }

  /** Par-время уровня: маршрут на эталонной скорости + запас на разгон. */
  get parSec(): number {
    return this.plan.routeLen / PAR_SPEED + 10;
  }

  /** Прямое расстояние до цели (для HUD). */
  get goalDist(): number {
    return Math.hypot(this.plan.goal.x - this.car.position.x, this.plan.goal.y - this.car.position.y);
  }

  /** Шаг симуляции; возвращает нарушения, случившиеся на этом шаге. */
  step(dt: number, input: CarInput): Violation[] {
    if (this.finished) return [];
    this.time += dt;
    const prev = { x: this.car.position.x, y: this.car.position.y };
    this.car.update(dt, input);

    const view: ActorView = {
      id: -1,
      x: this.car.position.x,
      y: this.car.position.y,
      heading: this.car.heading,
      speed: this.car.velocity,
      length: this.car.length,
      width: this.car.width,
    };
    this.traffic.update(dt, this.time, view);
    const fresh = this.rules.update(dt, this.time, view, this.traffic.vehicleViews(), this.traffic.pedViews());
    this.violations.push(...fresh);

    // дома и NPC — твёрдые: откат позиции и сброс скорости
    if (this.hitsSolid()) {
      this.car.position.x = prev.x;
      this.car.position.y = prev.y;
      this.car.velocity = 0;
    }

    if (this.goalDist < GOAL_RADIUS) {
      this.finished = true;
      this.score = computeScore(this.parSec, this.time, this.violations.length);
    }
    return fresh;
  }

  private hitsSolid(): boolean {
    const obb = this.car.getOBB();
    for (const b of this.plan.map.buildings) {
      if (obbIntersect(obb, rectToOBBRect(b))) return true;
    }
    for (const v of this.traffic.vehicleViews()) {
      if (obbIntersect(obb, { cx: v.x, cy: v.y, hx: v.length / 2, hy: v.width / 2, angle: v.heading })) {
        return true;
      }
    }
    return false;
  }
}
