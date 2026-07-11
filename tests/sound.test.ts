import { describe, expect, it } from 'vitest';
import { distGain, engineFreq, engineGain, honkDuration, tickFreq, tickPeriod } from '../src/ui/Sound';

// Тестируем только чистые маппинги: сам граф WebAudio в vitest недоступен
// (нет AudioContext), поэтому в нём — ноль логики (см. SOUND.md).
describe('Sound: чистые маппинги', () => {
  it('частота мотора: 55 Гц на холостых, растёт со скоростью, знак не важен', () => {
    expect(engineFreq(0)).toBe(55);
    expect(engineFreq(9)).toBe(55 + 14 * 9);
    expect(engineFreq(-5)).toBe(engineFreq(5)); // задний ход звучит так же
  });

  it('громкость мотора растёт со скоростью и ограничена сверху', () => {
    expect(engineGain(0)).toBeGreaterThan(0);
    expect(engineGain(9)).toBeGreaterThan(engineGain(0));
    expect(engineGain(100)).toBe(engineGain(14));
  });

  it('затухание по расстоянию: clamp01(1-d/R)²', () => {
    expect(distGain(0, 25)).toBe(1);
    expect(distGain(12.5, 25)).toBeCloseTo(0.25);
    expect(distGain(25, 25)).toBe(0);
    expect(distGain(40, 25)).toBe(0);
    expect(distGain(-3, 25)).toBe(1); // ближе нуля — не громче единицы
  });

  it('тики светофора: зелёный частый и выше, красный редкий, жёлтый молчит', () => {
    expect(tickPeriod('green')).toBeCloseTo(0.16);
    expect(tickPeriod('red')).toBe(1);
    expect(tickPeriod('red-yellow')).toBe(1);
    expect(tickPeriod('yellow')).toBeNull();
    expect(tickPeriod(null)).toBeNull();
    expect(tickFreq('green')).toBe(880);
    expect(tickFreq('red')).toBe(660);
  });

  it('клаксон: «подрезание» длиннее разовой «блокировки», повторы растут с потолком', () => {
    expect(honkDuration('blocked', 1)).toBeCloseTo(0.4);
    expect(honkDuration('blocked', 3)).toBeGreaterThan(honkDuration('blocked', 1));
    expect(honkDuration('blocked', 99)).toBeLessThanOrEqual(1.2);
    expect(honkDuration('cutoff', 1)).toBeCloseTo(0.7);
  });
});
