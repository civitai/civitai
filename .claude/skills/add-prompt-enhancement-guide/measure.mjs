#!/usr/bin/env node
/**
 * Measure a prompt-analysis guide against the live analyzer.
 *
 * The metric is *topic concentration*: what fraction of prompts get a recommendation on
 * each topic. A guide that reads the prompt advises differently on "a cat" than on a fully
 * specified scene; a guide walking its own `Flag …` list advises identically on both. Any
 * topic at or above 80% is firing regardless of the prompt, and against a 3-recommendation
 * cap each saturated topic is a slot permanently unavailable to anything prompt-specific.
 *
 * A redundancy score (recommending what the prompt already contains) is still reported, but
 * it is secondary — it turned out to be a weak proxy, catching only the sliver of the
 * problem where the prompt happened to contain the thing being recommended. On `minimaxh3`
 * it read 44% and called every intervention noise, while concentration showed audio at 100%
 * and camera at 96% across 23 unrelated prompts.
 *
 * Prompts come from the shared generic corpus in `prompts.json`. Keep it generic — a corpus
 * written while investigating one guide will flatter that guide's diagnosis (an earlier
 * five-prompt set loaded with camera/audio direction scored `minimaxh3` at 83% redundant;
 * the generic corpus puts it at 44%).
 *
 * Calls /v1/chat/completions directly rather than submitting a workflow, so a candidate
 * guide can be tested without registering it (a GET or PUT would add it to the registry
 * permanently). This approximates PromptEnhancementHandler: the output-format preamble
 * and json_schema here are reconstructed, and `enable_thinking:false` is not set, so
 * treat output-shape results as weaker evidence than content results.
 *
 *   node measure.mjs --ecosystem minimaxh3 --modality video
 *   node measure.mjs --ecosystem flux1 --modality image --candidate ./new-guide.txt
 *   node measure.mjs --ecosystem minimaxh3 --samples ./samples.json --runs 4
 *   node measure.mjs --guide ./draft.txt --length micro
 *
 * --runs multiplies the corpus; 2 runs of 23 prompts already beats 6 runs of the old 5.
 */
import fs, { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const args = process.argv.slice(2);
const flag = (name) => {
  const i = args.indexOf(`--${name}`);
  return i === -1 ? undefined : args[i + 1];
};

const ecosystem = flag('ecosystem');
const guidePath = flag('guide');
const candidatePath = flag('candidate');
const samplesPath = flag('samples');
const promptsPath = flag('prompts');
const dumpPath = flag('dump');
const modality = flag('modality');
const length = flag('length');
const runs = Number(flag('runs') ?? 2);

if (!ecosystem && !guidePath) {
  console.error('Need --ecosystem <key> (fetch the live guide) or --guide <file>.');
  process.exit(1);
}

for (const envPath of ['.env', '.claude/skills/add-prompt-enhancement-guide/.env']) {
  try {
    for (const line of readFileSync(resolve(process.cwd(), envPath), 'utf8').split('\n')) {
      const m = line.match(/^([A-Z_]+)=(.*)$/);
      if (m) process.env[m[1]] ??= m[2].trim().replace(/^["']|["']$/g, '');
    }
  } catch {
    // optional
  }
}

const endpoint = process.env.ORCHESTRATOR_ENDPOINT;
const token = process.env.ORCHESTRATOR_ACCESS_TOKEN;
if (!endpoint || !token) {
  console.error('ORCHESTRATOR_ENDPOINT and ORCHESTRATOR_ACCESS_TOKEN must be set.');
  process.exit(1);
}

const MODEL =
  process.env.PROMPT_ANALYSIS_MODEL ??
  'urn:air:qwen3:repository:huggingface:Civitai/Qwen3.6-35B-A3B-Abliterated-AWQ@main.tar';

const SCHEMA = {
  type: 'object',
  properties: {
    issues: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          description: { type: 'string' },
          severity: { type: 'string', enum: ['info', 'warning', 'error'] },
        },
        required: ['description', 'severity'],
        additionalProperties: false,
      },
    },
    recommendations: { type: 'array', items: { type: 'string' } },
    enhancedPrompt: { type: 'string' },
    enhancedNegativePrompt: { type: 'string' },
  },
  required: ['issues', 'recommendations', 'enhancedPrompt', 'enhancedNegativePrompt'],
  additionalProperties: false,
};

const OUTPUT_FORMAT =
  'Respond with a JSON object containing: issues (array of {description, severity}), ' +
  'recommendations (array of strings), enhancedPrompt (string), and enhancedNegativePrompt ' +
  '(string, empty when not applicable).';

/**
 * The corpus is deliberately generic and shared across every ecosystem — the same prompts
 * go to each guide, and each should improve them differently. `has` is what a prompt
 * already supplies; recommending one of those back is the failure being counted.
 */
const corpus = JSON.parse(
  readFileSync(
    promptsPath ? resolve(promptsPath) : fileURLToPath(new URL('./prompts.json', import.meta.url)),
    'utf8'
  )
);
const PROMPTS = corpus.prompts.filter(
  (p) =>
    (!modality || p.modality === modality || p.modality === 'both') &&
    (!length || p.length === length)
);

if (!PROMPTS.length) {
  console.error('No prompts matched the --modality / --length filters.');
  process.exit(1);
}

const dump = [];

/**
 * The primary metric: what fraction of prompts get a recommendation on each topic.
 *
 * A guide that reads the prompt produces different advice for "a cat" than for a fully
 * specified scene. A guide walking its own `Flag …` list produces the same advice for both,
 * and a topic saturating near 100% is that failure made visible — those slots are spent
 * before the prompt is considered, against a 3-recommendation cap.
 *
 * This supersedes the redundancy score below, which only caught the special case where the
 * prompt happened to already contain the thing being recommended. Measured on `minimaxh3`:
 * redundancy said 44% and looked like noise against every intervention; concentration showed
 * audio at 100% and camera at 96% across 23 unrelated prompts.
 */
const TOPICS = {
  camera:
    /camera|locked frame|push[- ]in|dolly|zoom|pan\b|tracking|framing|static (wide|shot)|drift/i,
  audio: /audio|sound|stereo|sonic|foley|ambien|hum\b|murmur/i,
  lighting: /light|lighting|illuminat|shadow|golden hour|backlit/i,
  composition: /composition|foreground|background|rule of thirds|layout|negative space/i,
  style: /style|render|painterly|photoreal|aesthetic/i,
  temporal: /beat|temporal|over time|sequence|progress|duration|seconds/i,
  subject: /observable|specific detail|appearance|describe the|more specific|visual detail/i,
  negatives: /negative prompt|positive (constraint|descriptor)|exclusion/i,
  text: /on-screen text|quoted|text string|rendered text/i,
};

/** Above this, a topic is firing regardless of the prompt rather than in response to it. */
const SATURATED = 0.8;

const HINTS = {
  subject:
    /\b(specific|detail|describe|elaborat|vague|generic)\w*\b.{0,40}\b(subject|character|figure|appearance)\b|\b(subject|character|figure)\b.{0,40}\b(specific|detail|describe)\w*/i,
  lighting: /light|lighting|illuminat|shadow|golden hour|backlit|rim light|key light/i,
  camera:
    /camera|shot|angle|lens|framing|locked frame|push[- ]in|dolly|pan|zoom|tracking|depth of field/i,
  composition:
    /composition|foreground|background|frame|placement|rule of thirds|layout|negative space/i,
  style: /style|render|medium|painterly|photoreal|aesthetic|artistic/i,
  audio: /audio|sound|stereo|sonic|soundtrack|foley|ambien/i,
  negative: /negative prompt/i,
};

/**
 * A GET registers whatever it reads, so only pass an --ecosystem that already exists
 * (confirm with `manage.mjs status`). Probing a spelling here leaves permanent junk.
 */
async function fetchLiveGuide(key) {
  const path = `/v1/manager/prompt-analysis/${encodeURIComponent(key.toLowerCase())}`;
  const res = await fetch(`${endpoint}${path}`, {
    headers: { authorization: `Bearer ${token}` },
  });
  if (!res.ok) throw new Error(`Could not read guide for "${key}": ${res.status}`);
  return (await res.json()).systemPrompt;
}

/**
 * Replays samples as user/assistant turns between the system prompt and the real
 * request — the same placement `PromptEnhancementHandler` uses, so a sample measured
 * here behaves the way it will once deployed via `manage.mjs set-samples`.
 */
function sampleTurns(samples) {
  return (samples ?? []).flatMap((s) => [
    {
      role: 'user',
      content: s.negativePrompt ? `${s.prompt}\n\nNegative prompt: ${s.negativePrompt}` : s.prompt,
    },
    { role: 'assistant', content: s.assistantResponse },
  ]);
}

async function analyze(systemPrompt, entry, samples, attempt = 0) {
  const userTurn = entry.negativePrompt
    ? `${entry.text}\n\nNegative prompt: ${entry.negativePrompt}`
    : entry.text;
  const res = await fetch(`${endpoint}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: JSON.stringify({
      model: MODEL,
      temperature: 0.7,
      messages: [
        { role: 'system', content: `${systemPrompt}\n\n${OUTPUT_FORMAT}` },
        ...sampleTurns(samples),
        { role: 'user', content: userTurn },
      ],
      response_format: {
        type: 'json_schema',
        json_schema: { name: 'analysis', schema: SCHEMA, strict: true },
      },
    }),
  });
  const text = await res.text();
  if (!res.ok) {
    if (attempt < 2) return analyze(systemPrompt, entry, samples, attempt + 1);
    return null;
  }
  const content = JSON.parse(text).choices?.[0]?.message?.content ?? '';
  try {
    return JSON.parse(content.replace(/^[\s\S]*?<\/think>/, '').trim());
  } catch {
    return attempt < 2 ? analyze(systemPrompt, entry, samples, attempt + 1) : null;
  }
}

async function score(label, guide, samples) {
  let redundant = 0;
  let possible = 0;
  let recs = 0;
  let overCap = 0;
  let n = 0;
  const echoed = [];
  const topics = Object.fromEntries(Object.keys(TOPICS).map((t) => [t, 0]));

  for (let r = 0; r < runs; r++) {
    for (const p of PROMPTS) {
      const out = await analyze(guide, p, samples);
      if (!out) continue;
      const hits = p.has.filter((h) => out.recommendations.some((x) => HINTS[h].test(x)));
      hits.forEach((h) => echoed.push(`${p.id}:${h}`));
      // The metric can only reject; auditing it means reading what it scored.
      if (dumpPath) {
        dump.push({
          arm: label,
          id: p.id,
          has: p.has,
          flagged: hits,
          prompt: p.text,
          negativePrompt: p.negativePrompt,
          recommendations: out.recommendations,
          enhancedPrompt: out.enhancedPrompt,
          enhancedNegativePrompt: out.enhancedNegativePrompt,
        });
      }
      for (const [t, re] of Object.entries(TOPICS)) {
        if (out.recommendations.some((x) => re.test(x))) topics[t]++;
      }
      redundant += hits.length;
      possible += p.has.length;
      recs += out.recommendations.length;
      if (out.recommendations.length > 3) overCap++;
      n++;
    }
  }

  // Without this, a run where every call failed prints `avg recs NaN` next to a confident
  // verdict line, which reads exactly like a real "no effect" result.
  if (n === 0) {
    console.error(
      `\n${label}: every request failed — no data. Check the endpoint and re-run; this is not a result.`
    );
    process.exit(1);
  }
  const expected = runs * PROMPTS.length;
  if (n < expected * 0.9) {
    console.warn(`  ! ${label}: only ${n}/${expected} calls succeeded — treat as provisional`);
  }

  const ranked = Object.entries(topics)
    .map(([t, c]) => [t, c / n])
    .filter(([, rate]) => rate > 0.05)
    .sort((a, b) => b[1] - a[1]);
  const saturated = ranked.filter(([, rate]) => rate >= SATURATED);

  console.log(`\n${label}`);
  for (const [t, rate] of ranked) {
    const bar = '#'.repeat(Math.round(rate * 25)).padEnd(25);
    console.log(
      `  ${t.padEnd(12)} ${bar} ${String(Math.round(rate * 100)).padStart(3)}%` +
        (rate >= SATURATED ? '   <- saturated' : '')
    );
  }
  // over-cap swings widely between runs of the *same* guide (measured 0/30 to 6/30 on one
  // unchanged guide), so read it as a rough indicator, never as a small-delta signal.
  console.log(
    `  ${'—'.padEnd(12)} saturated topics: ${saturated.length}   ` +
      `redundant ${redundant}/${possible}   avg recs ${(recs / n).toFixed(
        2
      )}   over-cap ${overCap}/${n}`
  );
  return { redundant, possible, echoed, saturated: saturated.length, ranked };
}

const baseline = guidePath
  ? readFileSync(resolve(guidePath), 'utf8')
  : await fetchLiveGuide(ecosystem);

const samples = samplesPath ? JSON.parse(readFileSync(resolve(samplesPath), 'utf8')) : null;
if (samples) {
  for (const s of samples) {
    // set-samples enforces this too, but failing here saves a paid round trip.
    JSON.parse(s.assistantResponse);
  }
}

// Read every input before the first API call. A run takes ~10 minutes, and reading the
// candidate lazily meant an edit landing mid-run silently swapped what was being measured
// against a baseline already scored under the old text — producing a number for a
// configuration that never existed.
const candidate = candidatePath ? readFileSync(resolve(candidatePath), 'utf8') : null;

console.log(`model: ${MODEL.split(':').pop()}   runs: ${runs}   prompts: ${PROMPTS.length}\n`);
const a = await score(guidePath ? 'guide' : `${ecosystem} (live)`, baseline, null);

if (dumpPath) {
  // written before the verdict so a crashed run still leaves its evidence
  process.on('exit', () => fs.writeFileSync(resolve(dumpPath), JSON.stringify(dump, null, 2)));
}

if (candidate || samples) {
  const label = candidate ? (samples ? 'candidate + samples' : 'candidate') : 'live + samples';
  const b = await score(label, candidate ?? baseline, samples);

  const rateOf = (r, t) => r.ranked.find(([k]) => k === t)?.[1] ?? 0;
  const moved = [...new Set([...a.ranked, ...b.ranked].map(([t]) => t))]
    .map((t) => [t, rateOf(b, t) - rateOf(a, t)])
    .filter(([, d]) => Math.abs(d) >= 0.1)
    .sort((x, y) => x[1] - y[1]);

  console.log('\ndelta');
  console.log(`  saturated topics  ${a.saturated} -> ${b.saturated}`);
  for (const [t, d] of moved) {
    console.log(`  ${t.padEnd(16)} ${d > 0 ? '+' : ''}${Math.round(d * 100)}%`);
  }
  console.log(`  redundant         ${a.redundant}/${a.possible} -> ${b.redundant}/${b.possible}`);

  // NOISE FLOOR, measured 2026-08-07 by comparing a guide against a byte-identical copy of
  // itself: saturated topics scored 1,2,2,1,2,1 across six arms, and one topic swung from
  // <25% to 93% between arms. A one-topic delta is indistinguishable from nothing. The
  // previous verdict line called that null comparison shippable in two runs out of three.
  const satDelta = a.saturated - b.saturated;
  const bigTopicMove = moved.some(([, d]) => Math.abs(d) >= 0.25);
  console.log(
    satDelta >= 2
      ? '\nCleared 2+ saturated topics — outside the ±1 noise floor. Re-run to confirm, then ship.'
      : satDelta === 1 && bigTopicMove
      ? '\nOne topic cleared alongside a >=25pt per-topic move. Plausible, but a 1-topic delta is\n' +
        'INSIDE the noise floor: ship only if a second independent run reproduces both.'
      : satDelta === 1
      ? '\nOne topic cleared with no large per-topic move. That is exactly the noise floor\n' +
        '(identical text scores ±1). This is not evidence — do not ship on it.'
      : satDelta <= -1
      ? '\nSaturation rose, but a 1-topic move is within noise. Re-run before calling it a regression.'
      : '\nNo change beyond noise.'
  );
}
