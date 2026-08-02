/**
 * Buzz Beggars Board (collection 3870938) auto-moderator — CLASSIFY ONLY.
 *
 * Usage:
 *   node scripts/oneoffs/buzz-beggars-classifier.mjs fetch            # pending REVIEW items -> pending.json
 *   node scripts/oneoffs/buzz-beggars-classifier.mjs classify [--limit N] [--ids 1,2] [--model X]
 *   node scripts/oneoffs/buzz-beggars-classifier.mjs validate         # run the 4 ground-truth samples
 *   node scripts/oneoffs/buzz-beggars-classifier.mjs report           # summarize results.jsonl
 *   node scripts/oneoffs/buzz-beggars-classifier.mjs bakeoff --models a,b,c [--sample 25]
 *
 * Defaults to OpenRouter. PROVIDER=gemini + GOOGLE_API_KEY calls Google directly (drop the
 * "google/" model prefix).
 *
 * Never writes to the database. Applying decisions is a separate, gated script.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import dotenv from 'dotenv';

dotenv.config();

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUT_DIR = path.join(__dirname, '.buzz-beggars');
fs.mkdirSync(OUT_DIR, { recursive: true });
const PENDING_FILE = path.join(OUT_DIR, 'pending.json');
const RESULTS_FILE = process.env.RESULTS_FILE || path.join(OUT_DIR, 'results.jsonl');

const COLLECTION_ID = 3870938;
const CDN = 'https://image.civitai.com/xG1nkqKTMzGDvpLrqFT7WA';
const DEFAULT_MODEL = 'google/gemini-2.5-flash';
const CONCURRENCY = 8;
// PROVIDER=gemini calls Google directly (model name drops the "google/" prefix).
const USE_GEMINI = process.env.PROVIDER === 'gemini';

/**
 * Criteria are transcribed from policy, not invented here:
 *   - src/static-content/tos.green.md §9.6 prohibited content (civitai.com is the green domain)
 *   - src/static-content/rules/minors.md  (photorealism is the bright line; stylized minors
 *     are allowed only when clothing, poses and interactions are age-appropriate)
 *   - src/static-content/rules/real-people.md (zero real-person likeness, living or deceased)
 * The Buzz-reference requirement is collection-specific, not a TOS rule.
 */
const SYSTEM_PROMPT = `You are moderating submissions to Civitai's "Buzz Beggars Board," a collection on civitai.com where users post an image asking the community to send them Buzz (Civitai's currency). Approved items appear on the site homepage, so they must satisfy the civitai.com (SFW) Terms of Service.

Report these observations about the submission. Be accurate and literal; a separate rules engine turns your observations into the final decision.

A. SEXUAL / ADULT CONTENT — judge only what is actually VISIBLE. Do not infer intent from setting, outfit category, or art style.

   Set sexualContent true if you can point to any of these in the image:
   - visible genitalia, female nipples or areolas, or bare buttocks
   - fabric so sheer that the above are visible through it
   - a depicted sexual act, masturbation, or sexual contact, including hands (or objects) groping
     or grabbing breasts, buttocks, or crotch — whether or not the person is clothed
   - bondage, restraints, rope, collars with leashes, gags, or other fetish gear used on a person
   - visible arousal cues presented as the subject: heavy blushing combined with sweat, panting or
     open-mouthed moaning expressions, drooling, or a body writhing in apparent pleasure
   - framing where a crotch or breasts fill most of the frame as the clear subject
   - a violation hidden behind black bars, blur, or censor stickers

   Clothing does not neutralize any of the above. A fully-clothed person who is bound or groped is
   still sexual content.

   Separately, set suggestiveStyling true when there is no act or exposure as above, but the image
   is still built to titillate: anatomy inflated well past the normal range of anime, comic and
   game art so that the exaggerated body is the subject; or a deliberately seductive pose or
   expression aimed at the viewer. Flagging this likely means the entry is rejected, so set it only
   when you are confident; ordinary attractive characters do not qualify.

   Set sexualContent FALSE for all of the following. These are common, allowed, and must NOT be
   called suggestive on their own or in combination:
   - short skirts, miniskirts, thigh-high socks or stockings, garters, crop tops, bare midriff
   - bare legs, arms, shoulders, or back; tank tops, sports bras, gym wear, leggings
   - swimwear, bikinis, or beachwear in an ordinary setting
   - armor, fantasy or costume outfits that expose skin
   - tight or form-fitting clothing of any kind
   - visible cleavage that is not the main subject of the frame
   - ordinary stylized proportions: a curvy, busty, muscular or otherwise idealized figure drawn
     within the normal range of anime, comic and game art
   - sitting, kneeling, lying down, leaning, arms crossed, hand on hip, or looking over a shoulder
   - a bedroom, bed, bathroom, shower, ring light, or webcam in the background

   Test to apply: would this outfit and pose be unremarkable in a PG-13 movie or at a public beach?
   If yes, sexualContent is false. When genuinely torn, set it false — a human reviews borderline
   cases separately.

B. MINORS — art style tells you NOTHING about age. Anime, cartoon, and stylized characters are
   drawn with large eyes, small noses and soft features by convention, and are overwhelmingly
   intended as adults. Never infer "minor" from art style, small stature, flat chest, a school or
   magical-girl uniform, twin tails, or a cute expression.

   Set depictsMinor true ONLY with unambiguous child indicators — clear child body proportions
   (large head relative to body, no adult proportions) together with a young child's face, or an
   explicit young-child context such as toys, a playground, or an elementary-school setting.
   A character who could reasonably be an adult IS an adult. If uncertain, set depictsMinor false
   and minorUncertain true. Judge the image, not the generation prompt: wording in the prompt never
   makes a visibly adult subject a minor.
   - when a minor is genuinely present, report whether they are photorealistic (could be mistaken
     for a photo of a real child) rather than drawn/stylized
   - report minorInappropriate only for clear sexualization of that child, using section A's
     visible-only standard — not for a short skirt or bare legs

C. REAL PEOPLE — set depictsRealPerson only if you can NAME the specific real person the image
   depicts. A generic attractive face, a photorealistic render, or a "celebrity-like" look is NOT a
   real person. If you cannot name who it is, it is not a real person.

D. OTHER PROHIBITED CONTENT — report ONLY these exact categories, using this exact spelling, and
   only when clearly depicted. Use an empty array when none apply:
   - "graphic violence" — visible gore, mutilation, serious injury, or death. A character merely
     holding or wearing a weapon is NOT graphic violence. Minor scratches or cartoon bruises are not.
   - "illegal drugs" — depicted use or promotion of illegal narcotics.
   - "self-harm" — cutting, suicide, or disordered-eating themes.
   - "hate or extremism" — hate speech, hateful symbols, or extremist propaganda. Do not guess at
     nonsense words or invented names; if you cannot identify a real slur or hate symbol, omit this.
   Do not invent categories outside this list. Profanity, weapons, spooky imagery, mild injury,
   crime themes, and edgy humor are NOT violations.

E. BUZZ REFERENCE (collection requirement) — set hasBuzzReference TRUE if EITHER of these appears
   anywhere in the image:
   (a) the word "buzz" in any form or spelling — "buz", "buzz plz", "buzzz", "BUZZING", "BUZZ MART".
       It does not have to be a request. Signage, logos, clothing, product labels, speech bubbles
       and background text all count.
   (b) a clearly recognizable lightning-bolt shape — the familiar jagged zigzag. Any color and any
       size counts, decorative or not, and it need not be Civitai's official icon. But it must be
       identifiable as a lightning bolt on sight.

   Both must be legible. A glow, a light flare, a sparkle, an unreadable scrawl, a smudge, or text
   too small or blurry to read is NOT a buzz reference, even if something suggests one might be
   there. If you find yourself saying "bolt-like", "appears to be", or "possibly", the answer is
   false.

   Consistency check: if your own reason states that the word "buzz" or a lightning bolt is
   present, hasBuzzReference MUST be true.

Weigh the image first; use the generation prompt only as supporting context.

Respond as JSON:
{"reason":"<one short sentence>",
 "sexualContent":true|false,
 "suggestiveStyling":true|false,
 "nsfwEstimate":"PG"|"PG-13"|"R+",
 "depictsMinor":true|false,
 "minorUncertain":true|false,
 "minorIsPhotorealistic":true|false,
 "minorInappropriate":true|false,
 "depictsRealPerson":true|false,
 "otherViolations":[],  // only: "graphic violence", "illegal drugs", "self-harm", "hate or extremism"
 "hasBuzzReference":true|false}`;

// Closed set. Anything the model invents outside this list escalates instead of rejecting —
// during calibration every single free-text category it produced was a false positive.
const KNOWN_VIOLATIONS = ['graphic violence', 'illegal drugs', 'self-harm', 'hate or extremism'];

// Rejection reasons are shown to the submitter, so the copy is fixed here rather than passing
// through whatever the model wrote. Its own wording stays internal for auditing.
const USER_MESSAGE = {
  'sexual/adult content':
    "Your entry wasn't accepted because the Buzz Beggars Board shows on the homepage and needs to stay PG-13.",
  'no buzz reference':
    "Your entry wasn't accepted because it doesn't mention Buzz. Add 'buzz pls' text or a Buzz lightning bolt and try again!",
  'graphic violence':
    "Your entry wasn't accepted because it shows graphic violence or injury.",
  'illegal drugs': "Your entry wasn't accepted because it depicts illegal substances.",
  'self-harm': "Your entry wasn't accepted because it touches on self-harm themes.",
  'hate or extremism': "Your entry wasn't accepted because it contains hateful or extremist content.",
};

/**
 * Deterministic policy layer. Kept out of the model so the rules are auditable and can be
 * retuned without reclassifying, and so a hedging model can't approve a TOS violation.
 */
function decide(o) {
  const violations = [];
  const escalations = [];

  // Zero-strike, ban-level policy areas. A flash-tier model is not accurate enough to auto-action
  // these (it read a photorealistic adult hiker as a minor during calibration), so they go to a
  // human instead of being silently rejected.
  if (o.depictsMinor && o.minorIsPhotorealistic) escalations.push('photorealistic minor');
  if (o.depictsMinor && o.minorInappropriate) escalations.push('minor depicted inappropriately');
  if (o.depictsRealPerson) escalations.push('real person likeness');

  if (o.sexualContent || o.nsfwEstimate === 'R+') violations.push('sexual/adult content');
  // Exposure and sexual acts are concrete enough to auto-reject. "Is this too sexy" is not: the
  // model split both ways on it during tuning, and so did the human passes. Send it to a person.
  else if (o.suggestiveStyling) escalations.push('suggestive styling');
  for (const v of o.otherViolations ?? []) {
    const norm = String(v).toLowerCase().trim();
    if (KNOWN_VIOLATIONS.includes(norm)) violations.push(norm);
    else escalations.push(`unrecognized category: ${v}`);
  }
  if (!o.hasBuzzReference) violations.push('no buzz reference');

  const decision = escalations.length ? 'ESCALATE' : violations.length ? 'REJECT' : 'APPROVE';
  return { decision, violations, escalations, userMessage: USER_MESSAGE[violations[0]] };
}

// Hand labels used to sanity-check the model before trusting it. Sample 4 is APPROVE per
// rules/minors.md: a cartoon minor in a wholesome context is allowed.
const GROUND_TRUTH = [
  { imageId: 138547028, expected: 'APPROVE', note: 'hiker, "buzz pls" speech bubble' },
  { imageId: 138355212, expected: 'REJECT', note: 'sheer lingerie, no buzz ref' },
  { imageId: 138524187, expected: 'REJECT', note: 'tasteful but no buzz ref' },
  { imageId: 68140663, expected: 'APPROVE', note: 'cartoon child + cat, buzz text, SFW' },
];

// anim=false makes the CDN return a still frame; without it a video item 400s as an unsupported
// image format (19 of the 640 pending submissions are videos).
const imageUrl = (item) =>
  `${CDN}/${item.url}/${item.type === 'video' ? 'anim=false,transcode=true,' : ''}width=512/x.jpeg`;

async function withDb(fn) {
  const client = new pg.Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();
  try {
    return await fn(client);
  } finally {
    await client.end();
  }
}

async function fetchPending() {
  const rows = await withDb(async (client) => {
    const { rows } = await client.query(
      `SELECT ci.id "ciId", i.id "imageId", i.url, i.type, i."nsfwLevel", i.meta->>'prompt' prompt
         FROM "CollectionItem" ci
         JOIN "Image" i ON i.id = ci."imageId"
        WHERE ci."collectionId" = $1 AND ci.status = 'REVIEW'
        ORDER BY ci.id`,
      [COLLECTION_ID]
    );
    return rows;
  });
  fs.writeFileSync(PENDING_FILE, JSON.stringify(rows, null, 2));
  console.log(`fetched ${rows.length} pending items -> ${PENDING_FILE}`);
  return rows;
}

async function fetchByImageIds(imageIds) {
  return withDb(async (client) => {
    const { rows } = await client.query(
      `SELECT ci.id "ciId", i.id "imageId", i.url, i.type, i."nsfwLevel", i.meta->>'prompt' prompt
         FROM "Image" i
         LEFT JOIN "CollectionItem" ci ON ci."imageId" = i.id AND ci."collectionId" = $1
        WHERE i.id = ANY($2::int[])`,
      [COLLECTION_ID, imageIds]
    );
    return rows;
  });
}

// Direct Google endpoint, used when OpenRouter has no credit. Same model, same prompt; Gemini
// takes inline bytes rather than a URL, so the image is fetched here.
async function callGemini(item, model) {
  const key = process.env.GOOGLE_API_KEY;
  if (!key) throw new Error('GOOGLE_API_KEY not set');
  const img = await fetch(imageUrl(item));
  if (!img.ok) throw new Error(`image fetch ${img.status}`);
  const bytes = Buffer.from(await img.arrayBuffer()).toString('base64');

  const res = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${key}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: SYSTEM_PROMPT }] },
        contents: [
          {
            role: 'user',
            parts: [
              { inlineData: { mimeType: 'image/jpeg', data: bytes } },
              {
                text: `Generation prompt: ${item.prompt ? item.prompt.slice(0, 1500) : '(none)'}`,
              },
            ],
          },
        ],
        generationConfig: {
          temperature: 0,
          maxOutputTokens: 4000,
          responseMimeType: 'application/json',
        },
      }),
    }
  );
  if (!res.ok) throw new Error(`${res.status} ${(await res.text()).slice(0, 300)}`);
  const json = await res.json();
  const text = json.candidates?.[0]?.content?.parts?.map((p) => p.text).join('') ?? '';
  return { parsed: JSON.parse(text), usage: json.usageMetadata };
}

async function classifyOne(item, model) {
  // Ingestion already rated these R or harder (NsfwLevel R=4, X=8, XXX=16, Blocked=32). They can
  // never belong on a homepage surface, so reject without spending a vision call.
  if (item.nsfwLevel >= 4) {
    return {
      ...item,
      decision: 'REJECT',
      violations: ['sexual/adult content'],
      escalations: [],
      reason: `Auto-rejected: ingestion nsfwLevel ${item.nsfwLevel} (R or above).`,
      nsfwEstimate: 'R+',
      sexualContent: true,
      autoRejected: true,
      model: 'nsfwLevel-prefilter',
    };
  }

  if (USE_GEMINI) {
    let lastErr;
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const { parsed, usage } = await callGemini(item, model);
        return { ...item, ...parsed, ...decide(parsed), model, usage };
      } catch (err) {
        lastErr = err;
        await new Promise((r) => setTimeout(r, 1000 * (attempt + 1)));
      }
    }
    return { ...item, decision: 'ERROR', reason: String(lastErr?.message ?? lastErr), model };
  }

  const body = {
    model,
    temperature: 0,
    // Without a cap, OpenRouter reserves the model's full 65k output window and 402s on credit headroom.
    // Generous: reasoning models spend this budget before emitting JSON, and a tight cap
    // truncates the response mid-object.
    max_tokens: 4000,
    response_format: { type: 'json_object' },
    messages: [
      { role: 'system', content: SYSTEM_PROMPT },
      {
        role: 'user',
        content: [
          { type: 'image_url', image_url: { url: imageUrl(item) } },
          {
            type: 'text',
            text: `Generation prompt: ${item.prompt ? item.prompt.slice(0, 1500) : '(none)'}`,
          },
        ],
      },
    ],
  };

  let lastErr;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const res = await fetch('https://openrouter.ai/api/v1/chat/completions', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${process.env.OPENROUTER_API_KEY}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(body),
      });
      if (!res.ok) throw new Error(`${res.status} ${(await res.text()).slice(0, 300)}`);
      const json = await res.json();
      const text = json.choices?.[0]?.message?.content ?? '';
      const parsed = JSON.parse(text.replace(/^```(?:json)?|```$/g, '').trim());
      return { ...item, ...parsed, ...decide(parsed), model, usage: json.usage };
    } catch (err) {
      lastErr = err;
      await new Promise((r) => setTimeout(r, 1000 * (attempt + 1)));
    }
  }
  return { ...item, decision: 'ERROR', reason: String(lastErr?.message ?? lastErr), model };
}

async function runPool(items, model, onResult) {
  let cursor = 0;
  let done = 0;
  const workers = Array.from({ length: Math.min(CONCURRENCY, items.length) }, async () => {
    while (cursor < items.length) {
      const item = items[cursor++];
      const result = await classifyOne(item, model);
      onResult(result);
      if (++done % 25 === 0) console.log(`  ${done}/${items.length}`);
    }
  });
  await Promise.all(workers);
}

async function classify(args) {
  const model = argValue(args, '--model') ?? DEFAULT_MODEL;
  const limit = Number(argValue(args, '--limit') ?? 0);
  const ids = argValue(args, '--ids');

  let items = fs.existsSync(PENDING_FILE)
    ? JSON.parse(fs.readFileSync(PENDING_FILE, 'utf8'))
    : await fetchPending();
  if (ids) {
    const wanted = new Set(ids.split(',').map(Number));
    items = items.filter((i) => wanted.has(i.imageId));
  }
  if (limit) items = items.slice(0, limit);

  // Resume: skip anything already classified successfully, so a mid-run provider failure
  // only costs the items that actually failed.
  if (fs.existsSync(RESULTS_FILE)) {
    const done = new Set(
      fs
        .readFileSync(RESULTS_FILE, 'utf8')
        .split('\n')
        .filter(Boolean)
        .map((l) => JSON.parse(l))
        .filter((r) => r.decision !== 'ERROR')
        .map((r) => r.imageId)
    );
    const before = items.length;
    items = items.filter((i) => !done.has(i.imageId));
    if (before !== items.length) console.log(`skipping ${before - items.length} already classified`);
  }

  const stream = fs.createWriteStream(RESULTS_FILE, { flags: 'a' });
  console.log(`classifying ${items.length} items with ${model}`);
  await runPool(items, model, (r) => stream.write(JSON.stringify(r) + '\n'));
  stream.end();
  console.log(`done -> ${RESULTS_FILE}`);
  report();
}

async function validate(args) {
  const model = argValue(args, '--model') ?? DEFAULT_MODEL;
  const rows = await fetchByImageIds(GROUND_TRUTH.map((g) => g.imageId));
  const byId = new Map(rows.map((r) => [r.imageId, r]));
  let agree = 0;
  for (const truth of GROUND_TRUTH) {
    const item = byId.get(truth.imageId);
    if (!item) {
      console.log(`imageId ${truth.imageId}: NOT FOUND`);
      continue;
    }
    const result = await classifyOne(item, model);
    const ok = result.decision === truth.expected;
    if (ok) agree++;
    console.log(
      `${ok ? 'MATCH ' : 'DIFF  '} imageId ${truth.imageId} expected=${truth.expected} got=${result.decision}\n` +
        `        signals: nsfw=${result.nsfwEstimate} sexual=${result.sexualContent} buzz=${result.hasBuzzReference}` +
        ` minor=${result.depictsMinor}/photoreal=${result.minorIsPhotorealistic}/inappropriate=${result.minorInappropriate}` +
        ` realPerson=${result.depictsRealPerson}\n` +
        `        violations: ${result.violations?.join(', ') || 'none'}\n` +
        `        model: ${result.reason}\n        label: ${truth.note}`
    );
  }
  console.log(`\nagreement: ${agree}/${GROUND_TRUTH.length} (${model})`);
}

function report() {
  if (!fs.existsSync(RESULTS_FILE)) return console.log('no results yet');
  const rows = fs
    .readFileSync(RESULTS_FILE, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l));
  const dedup = new Map(rows.map((r) => [r.imageId, r]));
  const all = [...dedup.values()];
  const counts = {};
  const byViolation = {};
  for (const r of all) {
    counts[r.decision] = (counts[r.decision] ?? 0) + 1;
    for (const v of r.violations ?? []) byViolation[v] = (byViolation[v] ?? 0) + 1;
  }
  console.log('\n--- report ---');
  console.log('total classified:', all.length);
  console.log('decisions:', counts);
  console.log('rejections by violation:', byViolation);
  console.log(
    'photorealistic minors (escalate, do not just reject):',
    all.filter((r) => r.depictsMinor && r.minorIsPhotorealistic).map((r) => r.imageId)
  );
  console.log(
    'errors:',
    all.filter((r) => r.decision === 'ERROR').map((r) => r.imageId)
  );
}

/**
 * Small-scale model comparison. Runs each candidate over the 4 hand-labeled samples plus a
 * fixed slice of real pending items, then reports ground-truth agreement and per-model decision
 * mix. Cross-model disagreements are printed so the calls that actually differ can be eyeballed.
 *
 *   node ... bakeoff --models a,b,c [--sample 25]
 */
async function bakeoff(args) {
  const models = (argValue(args, '--models') ?? DEFAULT_MODEL).split(',');
  const sampleSize = Number(argValue(args, '--sample') ?? 25);

  const truthRows = await fetchByImageIds(GROUND_TRUTH.map((g) => g.imageId));
  const pending = JSON.parse(fs.readFileSync(PENDING_FILE, 'utf8'));
  // Fixed stride rather than the first N, so the sample spans the whole backlog.
  const stride = Math.max(1, Math.floor(pending.length / sampleSize));
  const sample = pending.filter((_, i) => i % stride === 0).slice(0, sampleSize);

  const items = [...truthRows, ...sample];
  const byModel = {};
  for (const model of models) {
    const results = [];
    await runPool(items, model, (r) => results.push(r));
    byModel[model] = new Map(results.map((r) => [r.imageId, r]));

    let agree = 0;
    const errors = results.filter((r) => r.decision === 'ERROR');
    for (const truth of GROUND_TRUTH) {
      if (byModel[model].get(truth.imageId)?.decision === truth.expected) agree++;
    }
    const mix = {};
    for (const r of results) mix[r.decision] = (mix[r.decision] ?? 0) + 1;
    console.log(
      `\n${model}\n  ground truth: ${agree}/${GROUND_TRUTH.length}\n  decisions: ${JSON.stringify(mix)}` +
        (errors.length ? `\n  first error: ${errors[0].reason.slice(0, 160)}` : '')
    );
  }

  console.log('\n--- disagreements across models ---');
  for (const item of sample) {
    const calls = models.map((m) => byModel[m].get(item.imageId)?.decision);
    if (new Set(calls).size > 1) {
      console.log(`imageId ${item.imageId}: ${models.map((m, i) => `${m}=${calls[i]}`).join('  ')}`);
      for (const m of models) {
        const r = byModel[m].get(item.imageId);
        console.log(`    ${m}: ${r?.reason} [${r?.violations?.join(', ') || 'none'}]`);
      }
    }
  }
}

const argValue = (args, flag) => {
  const i = args.indexOf(flag);
  return i === -1 ? undefined : args[i + 1];
};

const [cmd, ...args] = process.argv.slice(2);
const commands = { fetch: fetchPending, classify, validate, report, bakeoff };
if (!commands[cmd]) {
  console.error(`usage: ${path.basename(process.argv[1])} <fetch|classify|validate|report|bakeoff>`);
  process.exit(1);
}
await commands[cmd](args);
