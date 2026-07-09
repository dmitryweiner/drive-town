import { describe, expect, it } from 'vitest';
import { generateLevel } from '../src/game/generate';
import { Round } from '../src/game/Round';
import { Autopilot } from './helpers/autopilot';

/** Сквозной тест разрешимости: «идеальный водитель» проходит
 * сгенерированный уровень с живым трафиком без нарушений. */
const SEEDS = [1, 2, 3, 7, 42, 123, 999, 20260709];
const DT = 1 / 30;
const MAX_TIME = 300;

describe('уровень проходим автопилотом', () => {
  for (const seed of SEEDS) {
    it(`seed=${seed}`, () => {
      const level = generateLevel(seed);
      const round = new Round(level);
      const ap = new Autopilot(round);
      while (!round.finished && round.time < MAX_TIME) {
        round.step(DT, ap.update());
      }
      expect(round.finished, `не доехал за ${MAX_TIME} с (seed=${seed})`).toBe(true);
      expect(round.violations, `нарушения: ${round.violations.map((v) => v.type).join(', ')}`)
        .toEqual([]);
      expect(round.score).toBeGreaterThan(0);
    });
  }
});
