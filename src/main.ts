import { generateLevel } from './game/generate';
import { Round } from './game/Round';
import { Hud } from './ui/Hud';
import { Input } from './ui/Input';
import { Minimap } from './ui/Minimap';
import { Renderer } from './ui/Renderer';
import { Sound } from './ui/Sound';

const STORAGE_KEY = 'drive-town-v1';
// отдельный ключ звука — схему SaveState не трогаем
const SOUND_KEY = 'drive-town-sound';

interface SaveState {
  level: number;
  total: number;
  seed: number;
}

const canvasEl = document.getElementById('game');
if (!(canvasEl instanceof HTMLCanvasElement)) throw new Error('Canvas #game not found');
const canvas = canvasEl;
const minimapEl = document.getElementById('minimap');
if (!(minimapEl instanceof HTMLCanvasElement)) throw new Error('Canvas #minimap not found');

const renderer = new Renderer(canvas);
const minimap = new Minimap(minimapEl);
const input = new Input();
const hud = new Hud();

// ?seed=123 — фиксированный город для отладки
const forcedSeed = new URLSearchParams(window.location.search).get('seed');

let save = restore();
if (forcedSeed !== null) save = { ...save, seed: Number(forcedSeed) };
let round = new Round(generateLevel(save.seed));
let scoreBanked = false;

function restore(): SaveState {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      const json: unknown = JSON.parse(raw);
      if (
        typeof json === 'object' && json !== null &&
        'level' in json && typeof json.level === 'number' &&
        'total' in json && typeof json.total === 'number' &&
        'seed' in json && typeof json.seed === 'number'
      ) {
        return { level: json.level, total: json.total, seed: json.seed };
      }
    }
  } catch {
    // повреждённое хранилище — начинаем заново
  }
  return { level: 1, total: 0, seed: newSeed() };
}

function persist(): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(save));
  } catch {
    // приватный режим и т.п. — просто не сохраняем
  }
}

function newSeed(): number {
  return Math.floor(Math.random() * 2 ** 31);
}

// звук: AudioContext создаётся лениво по клику «Поехали!» (autoplay-политика)
const sound = new Sound(readSoundPref());

function readSoundPref(): boolean {
  try {
    return localStorage.getItem(SOUND_KEY) === 'off';
  } catch {
    return false;
  }
}

const muteBtn = document.getElementById('btn-mute');
function syncMuteBtn(): void {
  if (!muteBtn) return;
  muteBtn.textContent = sound.isMuted ? '🔇' : '🔊';
  muteBtn.setAttribute('aria-pressed', String(sound.isMuted));
}
syncMuteBtn();
muteBtn?.addEventListener('click', () => {
  const muted = sound.toggleMuted();
  try {
    localStorage.setItem(SOUND_KEY, muted ? 'off' : 'on');
  } catch {
    // приватный режим и т.п. — просто не сохраняем
  }
  syncMuteBtn();
  muteBtn.blur(); // чтобы пробел (ручник) не «нажимал» кнопку снова
});

document.addEventListener('visibilitychange', () => {
  if (document.hidden) sound.suspend();
  else sound.resume();
});

// стартовый экран: симуляция стоит до клика «Поехали!»; этот клик — жест
// пользователя, разрешающий создать AudioContext
let started = false;
const startOverlay = document.getElementById('start-overlay');
document.getElementById('btn-start')?.addEventListener('click', () => {
  started = true;
  sound.init();
  startOverlay?.setAttribute('hidden', '');
});

// вращение карты по курсу машины (по умолчанию выключено)
const rotateBtn = document.getElementById('btn-rotate');
rotateBtn?.addEventListener('click', () => {
  rotateBtn.setAttribute('aria-pressed', String(renderer.toggleRotate()));
  rotateBtn.blur(); // чтобы пробел (ручник) не «нажимал» кнопку снова
});

// сброс прогресса: уровень 1, очки 0, новый город
document.getElementById('btn-reset')?.addEventListener('click', () => {
  if (!window.confirm('Сбросить прогресс (уровень и очки)?')) return;
  save = { level: 1, total: 0, seed: newSeed() };
  persist();
  round = new Round(generateLevel(save.seed));
  scoreBanked = false;
  sound.reset();
});

function isMobile(): boolean {
  if (window.matchMedia('(hover: none) and (pointer: coarse)').matches) return true;
  const hasTouch = 'ontouchstart' in window || (navigator.maxTouchPoints ?? 0) > 0;
  const smallerSide = Math.min(window.innerWidth, window.innerHeight);
  return hasTouch && smallerSide < 800;
}

renderer.resize();
if (isMobile()) {
  document.body.classList.add('is-mobile');
  renderer.setZoom(1.3);
}
const handleResize = (): void => renderer.resize();
window.addEventListener('resize', handleResize);
window.addEventListener('orientationchange', handleResize);
window.visualViewport?.addEventListener('resize', handleResize);
window.visualViewport?.addEventListener('scroll', handleResize);

canvas.addEventListener(
  'wheel',
  (e: WheelEvent) => {
    e.preventDefault();
    renderer.zoomBy(e.deltaY < 0 ? 1.12 : 1 / 1.12);
  },
  { passive: false },
);

let pinchInitialDist = 0;
let pinchInitialZoom = 1;
canvas.addEventListener(
  'touchstart',
  (e: TouchEvent) => {
    if (e.touches.length >= 2) {
      pinchInitialDist = touchDistance(e.touches[0], e.touches[1]);
      pinchInitialZoom = renderer.getZoom();
      e.preventDefault();
    }
  },
  { passive: false },
);
canvas.addEventListener(
  'touchmove',
  (e: TouchEvent) => {
    if (e.touches.length >= 2 && pinchInitialDist > 0) {
      renderer.setZoom(pinchInitialZoom * (touchDistance(e.touches[0], e.touches[1]) / pinchInitialDist));
      e.preventDefault();
    }
  },
  { passive: false },
);
const endPinch = (e: TouchEvent): void => {
  if (e.touches.length < 2) pinchInitialDist = 0;
};
canvas.addEventListener('touchend', endPinch);
canvas.addEventListener('touchcancel', endPinch);

let last = performance.now();
function loop(now: number): void {
  const dt = Math.min(0.05, (now - last) / 1000);
  last = now;

  if (input.consumeRetry()) {
    // уровень заново (тот же город)
    round = new Round(generateLevel(save.seed));
    scoreBanked = false;
    sound.reset();
  }
  if (input.consumeNext() && round.finished) {
    save = { level: save.level + 1, total: save.total + round.score, seed: newSeed() };
    persist();
    round = new Round(generateLevel(save.seed));
    scoreBanked = false;
    sound.reset();
  }

  const fresh = started ? round.step(dt, input.read()) : [];
  for (const v of fresh) hud.toast(v);
  sound.update(round, dt, fresh);

  if (round.finished && !scoreBanked) {
    scoreBanked = true;
    persist(); // очки добавятся при переходе, но сид/уровень фиксируем
  }

  renderer.render(round);
  minimap.render(round);
  hud.update(round, save.level, save.total);

  requestAnimationFrame(loop);
}
requestAnimationFrame(loop);

function touchDistance(a: Touch, b: Touch): number {
  return Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY);
}
