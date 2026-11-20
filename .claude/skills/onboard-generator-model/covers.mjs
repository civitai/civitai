#!/usr/bin/env node
/**
 * Launch covers for a new generator version, made by that version itself through the orchestrator.
 * See SKILL.md → Phase 6b. Reads ORCHESTRATOR_ENDPOINT / ORCHESTRATOR_ACCESS_TOKEN from the root .env.
 *
 *   node .claude/skills/onboard-generator-model/covers.mjs whatif <spec.json>
 *   node .claude/skills/onboard-generator-model/covers.mjs submit <spec.json>
 *
 * spec.json: [{ "dir": "<Version name> (<versionId>)", "name": "main", "stepType": "imageGen"|"videoGen",
 *               "input": { ...step input } }, ...]   (stepType defaults to imageGen)
 * Each entry is one imageGen/videoGen workflow; its outputs land in <launch-covers>/<dir>/<name>-<n>.<ext>.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import '../mod-actions/lib.mjs';

const [mode, specPath] = process.argv.slice(2);
if (!['whatif', 'submit'].includes(mode) || !specPath) {
  console.error('usage: covers.mjs whatif|submit <spec.json>');
  process.exit(1);
}

const API = (process.env.ORCHESTRATOR_ENDPOINT || '').replace(/\/+$/, '');
const TOKEN = process.env.ORCHESTRATOR_ACCESS_TOKEN;
if (!API || !TOKEN) throw new Error('ORCHESTRATOR_ENDPOINT / ORCHESTRATOR_ACCESS_TOKEN not set in the root .env');

const COVERS_ROOT = process.env.LAUNCH_COVERS_DIR || path.join(os.homedir(), 'Downloads', 'launch-covers');
const spec = JSON.parse(fs.readFileSync(specPath, 'utf8'));

async function api(method, url, body) {
  const res = await fetch(`${API}${url}`, {
    method,
    headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json', Accept: 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(60_000),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`${res.status} ${text.slice(0, 500)}`);
  return text ? JSON.parse(text) : null;
}

let total = 0;
const submitted = [];
for (const entry of spec) {
  const body = {
    tags: ['launch-covers'],
    steps: [{ $type: entry.stepType ?? 'imageGen', name: entry.name, input: entry.input }],
  };
  const wf = await api('POST', `/v2/consumer/workflows${mode === 'whatif' ? '?whatif=true' : ''}`, body);
  const cost = wf?.cost?.total ?? '?';
  if (typeof cost === 'number') total += cost;
  console.log(`${mode} ${entry.dir} ${entry.name}: cost ${cost}${mode === 'submit' ? ` id ${wf.id}` : ''}`);
  if (mode === 'submit') submitted.push({ ...entry, id: wf.id });
}
console.log(`total: ${total} Buzz`);
if (mode === 'whatif') process.exit(0);

const pending = new Set(submitted.map((s) => s.id));
const deadline = Date.now() + 20 * 60 * 1000;
while (pending.size && Date.now() < deadline) {
  for (const s of submitted) {
    if (!pending.has(s.id)) continue;
    const wf = await api('GET', `/v2/consumer/workflows/${s.id}`);
    if (!['succeeded', 'failed', 'expired', 'canceled'].includes(wf.status)) continue;
    pending.delete(s.id);
    const media = (wf.steps ?? []).flatMap((st) => [
      ...(st.output?.images ?? []),
      ...(st.output?.video ? [st.output.video] : []),
      ...(st.output?.videos ?? []),
    ]);
    console.log(`${s.dir} ${s.name}: ${wf.status}, ${media.length} file(s)`);
    const dir = path.join(COVERS_ROOT, s.dir);
    fs.mkdirSync(dir, { recursive: true });
    let n = 1;
    for (const m of media) {
      if (!m.url) continue;
      const r = await fetch(m.url, { signal: AbortSignal.timeout(300_000) });
      const type = r.headers.get('content-type') || '';
      const ext = type.includes('mp4') ? 'mp4' : type.includes('png') ? 'png' : type.includes('webp') ? 'webp' : 'jpg';
      const file = path.join(dir, `${s.name}-${n++}.${ext}`);
      fs.writeFileSync(file, Buffer.from(await r.arrayBuffer()));
      console.log(`  saved ${file}`);
    }
    if (wf.status !== 'succeeded') console.log(`  workflow ${s.id} ended ${wf.status}`);
  }
  if (pending.size) await new Promise((r) => setTimeout(r, 10_000));
}
if (pending.size) {
  console.log(`still running after 20 min: ${[...pending].join(', ')}`);
  process.exit(1);
}
