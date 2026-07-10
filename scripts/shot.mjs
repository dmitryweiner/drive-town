#!/usr/bin/env node
// Скриншоты игры в headless-Chromium — для визуальной проверки города.
//
//   node scripts/shot.mjs                    # случайный город
//   node scripts/shot.mjs 7 42               # конкретные сиды (?seed=)
//   node scripts/shot.mjs 7 --drive 4        # + подержать газ 4 с и снять второй кадр
//   node scripts/shot.mjs 7 --drift          # + разгон и руль+ручник (занос)
//   node scripts/shot.mjs 7 --zoomout 8      # отдалить камеру на N щелчков
//   node scripts/shot.mjs 7 --mobile         # мобильный вьюпорт с кнопками
//   node scripts/shot.mjs 7 --wait 3         # подождать перед кадром (default 1.5)
//
// Кадры пишутся в ./shots/seed-<seed>[-after|-drift].png. Dev-сервер
// поднимается сам (и гасится), если на :5173 ещё ничего не слушает.

import { spawn } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { chromium } from 'playwright';

const args = process.argv.slice(2);
const VALUE_FLAGS = new Set(['drive', 'wait', 'out', 'zoomout']);
const flags = new Map();
const seeds = [];
for (let i = 0; i < args.length; i++) {
  const a = args[i];
  if (a.startsWith('--')) {
    const name = a.slice(2);
    flags.set(name, VALUE_FLAGS.has(name) ? args[++i] : 'true');
  } else {
    seeds.push(a);
  }
}
const driveSec = Number(flags.get('drive') ?? 0);
const waitSec = Number(flags.get('wait') ?? 1.5);
const zoomOut = Number(flags.get('zoomout') ?? 0);
const drift = flags.has('drift');
const mobile = flags.has('mobile');
const outDir = flags.get('out') ?? 'shots';

const PORT = 5173;
const BASE = `http://localhost:${PORT}`;

async function serverUp() {
  try {
    const res = await fetch(BASE);
    return res.ok;
  } catch {
    return false;
  }
}

let devProc = null;
if (!(await serverUp())) {
  devProc = spawn('npx', ['vite', '--port', String(PORT), '--strictPort'], {
    stdio: 'ignore',
    detached: false,
  });
  for (let i = 0; i < 30 && !(await serverUp()); i++) {
    await new Promise((r) => setTimeout(r, 1000));
  }
  if (!(await serverUp())) {
    console.error(`dev-сервер не поднялся на :${PORT}`);
    process.exit(1);
  }
}

mkdirSync(outDir, { recursive: true });
const browser = await chromium.launch();
const page = await browser.newPage(
  mobile
    ? { viewport: { width: 420, height: 850 }, hasTouch: true, isMobile: true }
    : { viewport: { width: 1280, height: 800 } },
);
const errors = [];
page.on('pageerror', (e) => errors.push(String(e)));
page.on('console', (m) => {
  if (m.type() === 'error') errors.push(m.text());
});

for (const seed of seeds.length ? seeds : ['random']) {
  const url = seed === 'random' ? BASE : `${BASE}/?seed=${seed}`;
  const name = `seed-${seed}`;
  await page.goto(url);
  await page.waitForTimeout(waitSec * 1000);
  if (zoomOut > 0) {
    await page.mouse.move(640, 400);
    for (let i = 0; i < zoomOut; i++) {
      await page.mouse.wheel(0, 200);
      await page.waitForTimeout(40);
    }
    await page.waitForTimeout(300);
  }
  await page.screenshot({ path: `${outDir}/${name}.png` });
  console.log(`${outDir}/${name}.png`);

  if (driveSec > 0) {
    await page.keyboard.down('w');
    await page.waitForTimeout(driveSec * 1000);
    await page.keyboard.up('w');
    await page.waitForTimeout(500);
    await page.screenshot({ path: `${outDir}/${name}-after.png` });
    console.log(`${outDir}/${name}-after.png`);
  }

  if (drift) {
    await page.keyboard.down('w');
    await page.waitForTimeout(3000);
    await page.keyboard.down('d');
    await page.keyboard.down(' ');
    await page.waitForTimeout(700);
    await page.screenshot({ path: `${outDir}/${name}-drift.png` });
    await page.keyboard.up('w');
    await page.keyboard.up('d');
    await page.keyboard.up(' ');
    console.log(`${outDir}/${name}-drift.png`);
  }
}

console.log('console/page errors:', errors.length ? errors : 'none');
await browser.close();
devProc?.kill();
