#!/usr/bin/env node
// Run a capture script against a browser-automation session and keep its return value.
//
//   node .claude/skills/feature-walkthrough/capture.mjs <session> <script.js>
//
// The browser-automation server executes a chunk and DISCARDS whatever it returns, so a script
// that inspects the page has no way to report what it found. This wraps the script so its return
// value (or its stack, if it throws) lands in `<script.js>.out.json` and gets printed.
//
// Scripts run with `page` plus the helpers below already defined — see SKILL.md.

import { readFileSync, existsSync, unlinkSync, mkdirSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));

function readEnv(key, fallback) {
  if (process.env[key]) return process.env[key];
  try {
    const line = readFileSync(join(here, '.env'), 'utf8')
      .split('\n')
      .find((l) => l.startsWith(`${key}=`));
    if (line) return line.slice(key.length + 1).trim().replace(/^["']|["']$/g, '');
  } catch {
    /* no .env is fine — the defaults cover a stock setup */
  }
  return fallback;
}

const [session, file] = process.argv.slice(2);
if (!session || !file) {
  console.error('usage: capture.mjs <session> <script.js>');
  process.exit(1);
}

const api = readEnv('BROWSER_API', 'http://localhost:9222');
const shotsDir = resolve(readEnv('SHOTS_DIR', 'shots'));
mkdirSync(shotsDir, { recursive: true });

const outPath = resolve(`${file}.out.json`);
if (existsSync(outPath)) unlinkSync(outPath);

// Everything the capture scripts would otherwise re-solve every time.
const preamble = `
const SHOTS = ${JSON.stringify(shotsDir)};

// Overlays that sit above the page and swallow clicks. Without this, clicking anything below a
// sticky announcement fails with "<div ...> subtree intercepts pointer events" after a 30s retry.
const dismissOverlays = async () => {
  await page.evaluate(() => {
    document.querySelectorAll('div.sticky.inset-x-0.top-0.z-50').forEach((el) => el.remove());
    document.querySelectorAll('[data-testid="open-chat"]').forEach((el) => el.remove());
  });
  await page.waitForTimeout(200);
};

// clip is optional {x,y,width,height}; omit it for the full viewport.
const shot = async (name, clip) => {
  await page.screenshot({ path: SHOTS + '/' + name, ...(clip ? { clip } : {}) });
  return name;
};

// Element shots beat viewport shots for anything the DOM can scope — no clip maths, and the
// framing survives a layout change.
const shotOf = async (selector, name) => {
  await page.locator(selector).first().screenshot({ path: SHOTS + '/' + name });
  return name;
};

const shotModal = (name) => shotOf('.mantine-Modal-content', name);

const mainText = (max = 800) =>
  page.evaluate((n) => (document.querySelector('main')?.innerText || '').slice(0, n), max);

const modalText = (max = 1200) =>
  page
    .locator('.mantine-Modal-content')
    .first()
    .innerText()
    .then((t) => t.slice(0, max))
    .catch(() => null);
`;

const inner = readFileSync(file, 'utf8');
const code = `
const __fs = await import('node:fs');
${preamble}
let __r;
try {
  __r = await (async () => { ${inner}
  })();
} catch (e) {
  __r = { __error: String((e && e.stack) || e).slice(0, 3000) };
}
__fs.writeFileSync(${JSON.stringify(outPath)}, JSON.stringify(__r ?? null, null, 1));
`;

const res = await fetch(`${api}/chunk?session=${encodeURIComponent(session)}`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ label: file, code }),
});

const text = await res.text();
let data;
try {
  data = JSON.parse(text);
} catch {
  console.log(text.slice(0, 2000));
  process.exit(1);
}

if (data.type === 'chunk_failed') console.log('CHUNK FAILED:', data.error);
if (existsSync(outPath)) console.log('RESULT:', readFileSync(outPath, 'utf8').slice(0, 8000));
console.log('URL:', data.inspection?.url);
console.log('SHOT:', data.inspection?.screenshot);
