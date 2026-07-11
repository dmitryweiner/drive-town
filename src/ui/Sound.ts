import { approachOf } from '../game/Rules';
import type { Round } from '../game/Round';
import type { HonkEvent } from '../game/Traffic';
import type { LightState, Violation } from '../game/types';

// Чистый синтез Web Audio, ноль ассетов (SOUND.md). Маппинги ниже — чистые
// функции под vitest; сам граф WebAudio логики не содержит.

/** Радиус слышимости тиков светофора, м. */
export const LIGHT_RANGE = 25;
/** Радиус слышимости клаксона, м. */
export const HONK_RANGE = 45;
/** Повтор звука удара не чаще, с (контакт длится кадрами). */
const THUMP_COOLDOWN = 0.3;

/** Частота мотора: холостой 55 Гц, ~180 на 9 м/с. */
export function engineFreq(speed: number): number {
  return 55 + 14 * Math.abs(speed);
}

/** Громкость мотора: слышен на холостых, чуть растёт со скоростью.
 * Тихий фон — не должен заглушать светофор/клаксоны/удары. */
export function engineGain(speed: number): number {
  return 0.025 + 0.007 * Math.min(Math.abs(speed), 14);
}

/** Шорох шин при заносе ручника: от боковой скорости кузова (lateralV).
 * Порог отсекает лёгкий дрейф в обычном повороте. */
export function skidGain(lateralV: number): number {
  const a = Math.min(Math.abs(lateralV), 7);
  if (a < 1) return 0;
  return 0.3 * ((a - 1) / 6);
}

/** Затухание по расстоянию от машины игрока: clamp01(1 - d/R)². */
export function distGain(d: number, r: number): number {
  const k = Math.min(1, Math.max(0, 1 - d / r));
  return k * k;
}

/** Период тиков светофора по фазе; null — молчит (жёлтый / нет света). */
export function tickPeriod(light: LightState | null): number | null {
  if (light === 'green') return 0.16;
  if (light === 'red' || light === 'red-yellow') return 1.0;
  return null;
}

export function tickFreq(light: LightState): number {
  return light === 'green' ? 880 : 660;
}

/** Длительность гудка: у «блокировки» раздражение растёт с повторами. */
export function honkDuration(kind: HonkEvent['kind'], n: number): number {
  if (kind === 'cutoff') return 0.7;
  return Math.min(0.4 + 0.2 * (n - 1), 1.2);
}

export class Sound {
  private ctx: AudioContext | null = null;
  private master: GainNode | null = null;
  private engineGainNode: GainNode | null = null;
  private engineOscs: OscillatorNode[] = [];
  private skidGainNode: GainNode | null = null;
  private noise: AudioBuffer | null = null;
  private muted: boolean;
  private tickIn = 0;
  private lastThumpAt = -Infinity;

  constructor(muted = false) {
    this.muted = muted;
  }

  get isMuted(): boolean {
    return this.muted;
  }

  /** Ленивая инициализация — только по жесту пользователя (autoplay). */
  init(): void {
    if (this.ctx) return;
    const ctx = new AudioContext();
    const master = ctx.createGain();
    master.gain.value = this.muted ? 0 : 1;
    master.connect(ctx.destination);

    // мотор: saw + tri с лёгким detune → lowpass → gain, работает постоянно
    const saw = ctx.createOscillator();
    saw.type = 'sawtooth';
    const tri = ctx.createOscillator();
    tri.type = 'triangle';
    tri.detune.value = 12;
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.value = 1100;
    const gain = ctx.createGain();
    gain.gain.value = 0;
    saw.connect(lp);
    tri.connect(lp);
    lp.connect(gain);
    gain.connect(master);
    saw.start();
    tri.start();

    // буфер белого шума: «бух» удара и (зацикленно) шорох шин
    const noise = ctx.createBuffer(1, Math.ceil(ctx.sampleRate * 0.15), ctx.sampleRate);
    const data = noise.getChannelData(0);
    for (let i = 0; i < data.length; i++) data[i] = Math.random() * 2 - 1;

    // шорох шин при заносе ручника: шум → bandpass → gain, крутится всегда
    const skidSrc = ctx.createBufferSource();
    skidSrc.buffer = noise;
    skidSrc.loop = true;
    const bp = ctx.createBiquadFilter();
    bp.type = 'bandpass';
    bp.frequency.value = 1200;
    bp.Q.value = 0.7;
    const skid = ctx.createGain();
    skid.gain.value = 0;
    skidSrc.connect(bp);
    bp.connect(skid);
    skid.connect(master);
    skidSrc.start();

    this.ctx = ctx;
    this.master = master;
    this.engineGainNode = gain;
    this.engineOscs = [saw, tri];
    this.skidGainNode = skid;
    this.noise = noise;
  }

  /** Mute — ramp master в 0, контекст не закрываем. */
  toggleMuted(): boolean {
    this.muted = !this.muted;
    if (this.ctx && this.master) {
      this.master.gain.setTargetAtTime(this.muted ? 0 : 1, this.ctx.currentTime, 0.02);
    }
    return this.muted;
  }

  suspend(): void {
    void this.ctx?.suspend();
  }

  resume(): void {
    void this.ctx?.resume();
  }

  /** Сброс таймеров при новом раунде (R/N): round.time начинается заново. */
  reset(): void {
    this.tickIn = 0;
    this.lastThumpAt = -Infinity;
  }

  /** Каждый кадр после round.step(); все триггеры — по фронту событий. */
  update(round: Round, dt: number, fresh: Violation[]): void {
    // съём гудков даже без контекста — иначе очередь копится до init
    const honks = round.traffic.consumeHonks();
    const ctx = this.ctx;
    const master = this.master;
    if (!ctx || !master) return;
    const car = round.car;
    const now = ctx.currentTime;

    // мотор: pitch от скорости; раунд кончился — глушим
    const v = round.finished ? 0 : Math.abs(car.velocity);
    for (const osc of this.engineOscs) osc.frequency.setTargetAtTime(engineFreq(v), now, 0.05);
    this.engineGainNode?.gain.setTargetAtTime(round.finished ? 0 : engineGain(v), now, 0.08);

    // занос ручника: громкость от боковой скорости кузова
    const skid = round.finished ? 0 : skidGain(round.car.lateralV);
    this.skidGainNode?.gain.setTargetAtTime(skid, now, 0.04);

    // тики ближайшего светофора — фаза подъезда игрока; в квадрате или
    // спиной к узлу approachOf смотрит уже на следующий узел → тишина
    let period: number | null = null;
    let freq = 0;
    let gain = 0;
    if (!round.finished) {
      const ap = approachOf(round.plan.map, {
        id: -1,
        x: car.position.x,
        y: car.position.y,
        heading: car.heading,
        speed: car.velocity,
        length: car.length,
        width: car.width,
      });
      if (ap && ap.d > 0 && ap.d < LIGHT_RANGE && round.plan.map.nodes[ap.node].control === 'lights') {
        const light = round.plan.map.lightState(ap.node, ap.side, round.time);
        period = tickPeriod(light);
        if (light !== null && period !== null) {
          freq = tickFreq(light);
          gain = distGain(ap.d, LIGHT_RANGE);
        }
      }
    }
    if (period === null) {
      this.tickIn = 0;
    } else {
      this.tickIn -= dt;
      if (this.tickIn <= 0) {
        this.beep(freq, 0.25 * gain);
        this.tickIn = period;
      }
    }

    // клаксоны NPC — громкость по расстоянию до гудящего
    for (const h of honks) {
      const d = Math.hypot(h.x - car.position.x, h.y - car.position.y);
      this.honk(honkDuration(h.kind, h.n), 0.3 * distGain(d, HONK_RANGE));
    }

    // удар о твёрдое
    if (round.contact && round.time - this.lastThumpAt > THUMP_COOLDOWN) {
      this.lastThumpAt = round.time;
      this.thump(0.7 * Math.min(1, round.impactSpeed / 9));
    }

    // фиксация нарушения — UI-звук, без позиционирования, синхронен с тостом
    if (fresh.length > 0) this.buzzer();
  }

  /** Короткий sine-бип тика светофора, 15 мс. */
  private beep(freq: number, gain: number): void {
    const ctx = this.ctx;
    const master = this.master;
    if (!ctx || !master || gain < 0.001) return;
    const t = ctx.currentTime;
    const osc = ctx.createOscillator();
    osc.type = 'sine';
    osc.frequency.value = freq;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(gain, t + 0.005);
    g.gain.linearRampToValueAtTime(0, t + 0.015);
    osc.connect(g);
    g.connect(master);
    osc.start(t);
    osc.stop(t + 0.03);
  }

  /** Клаксон: два square в малую секунду (~400+424 Гц). */
  private honk(dur: number, gain: number): void {
    const ctx = this.ctx;
    const master = this.master;
    if (!ctx || !master || gain < 0.001) return;
    const t = ctx.currentTime;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(gain, t + 0.02);
    g.gain.setValueAtTime(gain, t + dur - 0.05);
    g.gain.linearRampToValueAtTime(0, t + dur);
    g.connect(master);
    for (const freq of [400, 424]) {
      const osc = ctx.createOscillator();
      osc.type = 'square';
      osc.frequency.value = freq;
      osc.connect(g);
      osc.start(t);
      osc.stop(t + dur + 0.02);
    }
  }

  /** «Бух» удара: burst шума через lowpass + sine 60 Гц. */
  private thump(gain: number): void {
    const ctx = this.ctx;
    const master = this.master;
    const noise = this.noise;
    if (!ctx || !master || !noise || gain < 0.001) return;
    const t = ctx.currentTime;
    const src = ctx.createBufferSource();
    src.buffer = noise;
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.value = 300;
    const g = ctx.createGain();
    g.gain.setValueAtTime(gain, t);
    g.gain.linearRampToValueAtTime(0, t + 0.12);
    src.connect(lp);
    lp.connect(g);
    g.connect(master);
    src.start(t);

    const osc = ctx.createOscillator();
    osc.type = 'sine';
    osc.frequency.value = 60;
    const g2 = ctx.createGain();
    g2.gain.setValueAtTime(gain, t);
    g2.gain.linearRampToValueAtTime(0, t + 0.15);
    osc.connect(g2);
    g2.connect(master);
    osc.start(t);
    osc.stop(t + 0.16);
  }

  /** Двухнотный нисходящий «бузер» нарушения: 620→415 Гц по 90 мс, square. */
  private buzzer(): void {
    const ctx = this.ctx;
    const master = this.master;
    if (!ctx || !master) return;
    const t = ctx.currentTime;
    const osc = ctx.createOscillator();
    osc.type = 'square';
    osc.frequency.setValueAtTime(620, t);
    osc.frequency.setValueAtTime(415, t + 0.09);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(0.12, t + 0.01);
    g.gain.setValueAtTime(0.12, t + 0.17);
    g.gain.linearRampToValueAtTime(0, t + 0.18);
    osc.connect(g);
    g.connect(master);
    osc.start(t);
    osc.stop(t + 0.2);
  }
}
