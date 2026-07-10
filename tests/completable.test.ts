import { describe, expect, it } from 'vitest';
import { generateLevel } from '../src/game/generate';
import { Round } from '../src/game/Round';
import { Autopilot } from './helpers/autopilot';

/** Сквозной тест разрешимости: «идеальный водитель» проходит
 * сгенерированный уровень с живым трафиком без нарушений. */
const SEEDS = [1, 2, 3, 7, 42, 123, 999, 20260709];
const DT = 1 / 30;
const MAX_TIME = 300;

/** Широкий свип при правках движка: SWEEP=40 npm test (сиды 1..N). */
const SWEEP = Number(process.env.SWEEP ?? 0);

function drive(seed: number): Round {
  const level = generateLevel(seed);
  const round = new Round(level);
  const ap = new Autopilot(round);
  while (!round.finished && round.time < MAX_TIME) {
    round.step(DT, ap.update());
  }
  return round;
}

describe('уровень проходим автопилотом', () => {
  for (const seed of SEEDS) {
    it(`seed=${seed}`, () => {
      const round = drive(seed);
      expect(round.finished, `не доехал за ${MAX_TIME} с (seed=${seed})`).toBe(true);
      expect(round.violations, `нарушения: ${round.violations.map((v) => v.type).join(', ')}`)
        .toEqual([]);
      expect(round.score).toBeGreaterThan(0);
    });
  }

  it.runIf(SWEEP > 0)(`свип сидов 1..${SWEEP}`, () => {
    const bad: string[] = [];
    for (let seed = 1; seed <= SWEEP; seed++) {
      const round = drive(seed);
      if (!round.finished) bad.push(`seed=${seed}: не доехал`);
      else if (round.violations.length > 0) {
        bad.push(`seed=${seed}: ${round.violations.map((v) => v.type).join(',')}`);
      }
    }
    expect(bad, bad.join('\n')).toEqual([]);
  }, 600000);
});
