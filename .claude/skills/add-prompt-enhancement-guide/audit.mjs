#!/usr/bin/env node
/**
 * Static audit of every live prompt-analysis guide.
 *
 * Every check below corresponds to a defect that was actually observed in output during the
 * 2026-08-05/06 audit, not to a style preference. None of them need the analyzer, so this runs
 * while /v1/chat/completions is down.
 *
 *   node audit.mjs                      # audit the live registry
 *   node audit.mjs --file <export.json> # audit an export
 *   node audit.mjs --key flux1          # one ecosystem, verbose
 *
 * A finding here is a candidate, not a verdict: confirm with `measure.mjs` once the endpoint
 * is back. The one exception is SMUGGLED-DURATION, which is a correctness bug regardless of
 * what any metric says.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const args = process.argv.slice(2);
const flag = (n) => {
  const i = args.indexOf(`--${n}`);
  return i === -1 ? undefined : args[i + 1];
};
const filePath = flag('file');
const onlyKey = flag('key');

/** Modalities the guide template does not describe; deliberately left on the default. */
const OUT_OF_SCOPE = new Set(['ace', 'tripo', 'hunyuan3d', 'polygen']);

function loadFromFile(p) {
  const raw = JSON.parse(readFileSync(resolve(p), 'utf8'));
  return raw.ecosystems ?? raw;
}

async function loadLive() {
  for (const envPath of ['.env', '.claude/skills/add-prompt-enhancement-guide/.env']) {
    try {
      for (const line of readFileSync(resolve(process.cwd(), envPath), 'utf8').split('\n')) {
        const m = line.match(/^([A-Z_]+)=(.*)$/);
        if (m) process.env[m[1]] ??= m[2].trim().replace(/^["']|["']$/g, '');
      }
    } catch {}
  }
  const endpoint = process.env.ORCHESTRATOR_ENDPOINT;
  const token = process.env.ORCHESTRATOR_ACCESS_TOKEN;
  const base = '/v1/manager/prompt-analysis';
  const names = await (
    await fetch(`${endpoint}${base}`, { headers: { authorization: `Bearer ${token}` } })
  ).json();
  const out = [];
  for (const name of names) {
    const cfg = await (
      await fetch(`${endpoint}${base}/${encodeURIComponent(name)}`, {
        headers: { authorization: `Bearer ${token}` },
      })
    ).json();
    out.push({ ecosystem: name, ...cfg });
  }
  return out;
}

/**
 * Split a guide into its two structural blocks. Where a line sits decides whether it costs a
 * recommendation slot, so nearly every check depends on this.
 */
function split(prompt) {
  const gi = prompt.search(/^Guidelines:/m);
  return gi === -1
    ? { rules: prompt, guidelines: '' }
    : { rules: prompt.slice(0, gi), guidelines: prompt.slice(gi) };
}

const CHECKS = [
  {
    id: 'SMUGGLED-DURATION',
    severity: 'bug',
    why: 'Teaches absolute timings, but the clip length is not in the analysis request. A prompt written to 12s is wrong for a 5s generation.',
    test: ({ prompt }) => {
      const hits = prompt.match(/\b\d+\s*-\s*\d+\s*s\b|\b\d+\s*seconds?\b|\b\d+\s*fps\b/gi) ?? [];
      // A stated capability range ("Duration: 5-15 seconds") is fine; an example the analyzer
      // is meant to imitate is not.
      const inExample = /"[^"]*\d+\s*-\s*\d+\s*s[^"]*"|\(\s*"?\d+\s*-\s*\d+s/.test(prompt);
      return hits.length && inExample ? hits.slice(0, 4) : null;
    },
  },
  {
    id: 'HARDCODED-DURATION',
    severity: 'warn',
    why: 'States a duration/fps as fact. Decided 2026-08-06 that duration is a generation parameter and does not belong in the prompt; these bullets should be deleted.',
    test: ({ prompt }) =>
      (prompt.match(/^-\s*(Duration|Length|Clip length|FPS)[:\s].*/gim) ?? []).slice(0, 2),
  },
  {
    id: 'ABSENCE-CHECK-IN-GUIDELINES',
    severity: 'warn',
    why: 'Guideline whose trigger is "the prompt lacks X" for an X most prompts lack. Fires every request and eats the 3-recommendation cap. Belongs in the rules block.',
    test: ({ guidelines }) =>
      (
        guidelines.match(
          /^-\s*(Flag|Suggest|Identify|Ensure|Check)\b[^\n]*\b(missing|absent|lack\w*|if none|when none|unspecified|no \w+ (is|are) (given|provided|specified))\b[^\n]*/gim
        ) ?? []
      ).slice(0, 4),
  },
  {
    id: 'GUIDELINE-COUNT',
    severity: 'info',
    why: 'Each guideline line is an invitation to emit a recommendation, against a cap of 3. Corpus average 3.6, max 9.',
    test: ({ guidelines }) => {
      const n = (guidelines.match(/^-\s+/gm) ?? []).length - 2; // minus the two required trailers
      return n > 4 ? [`${n} guideline lines`] : null;
    },
  },
  {
    id: 'EMPHATIC-CAPABILITY',
    severity: 'warn',
    why: 'A capability written up emphatically ("defining feature", "always", "critical") saturates its topic — the model recommends it on nearly every prompt. Measured on ltxv23: native audio described as "the model\'s defining capability" took audio from ~0% to 89% of recommendations and pushed saturated topics 1 -> 2. State the capability, then say the rewrite adds it silently.',
    test: ({ rules }) => {
      const loud = (
        rules.match(
          /^-[^\n]*\b(defining (capability|feature)|the model's (headline|signature)|most important|critical|essential|always carry|must always|never omit|arbitrary\b)[^\n]*/gim
        ) ?? []
      ).filter(
        (l) =>
          // A bullet that already tells the model not to raise it is the fixed form.
          !/do not raise|not as a (separate )?recommendation|shapes the rewrite/i.test(l) &&
          // "put the most important element first" is word-order advice about the prompt's
          // structure, not a capability the model will start recommending. flux1 and reve
          // both tripped on it.
          !/\b(order|first|front[- ]load|earlier|position|placement)\b/i.test(l)
      );
      return loud.length ? loud.slice(0, 3) : null;
    },
  },
  {
    id: 'SELF-NARRATION',
    severity: 'warn',
    why: 'Guide talks about itself in a register the model echoes. Observed leaking verbatim into enhancedPrompt.',
    test: ({ prompt }) =>
      (
        prompt.match(
          /[^\n]*\b(highest[- ]leverage|most impactful thing|buys more than|is worth more than|the key insight|rule of thumb)\b[^\n]*/gi
        ) ?? []
      ).slice(0, 2),
  },
  {
    id: 'OUT-OF-PAYLOAD',
    severity: 'bug',
    why: 'Conditions on a fact the analyzer cannot see (checkpoint variant, resolution, step count). It hedges or drops the condition; either way the line is dead weight.',
    // Must be a genuine *branch* on an unobservable fact, not merely a sentence that mentions
    // a checkpoint. Requires the conditional word and the variant word within ~60 chars of
    // each other, which is what separates "only works with the Full variant" (a real branch)
    // from "short prompts do poorly on this preview checkpoint" (a plain statement).
    test: ({ prompt }) =>
      (
        prompt.match(
          /[^\n]*\b(only|if|when|depend\w*)\b.{0,60}\b(variant|Full|Turbo|Dev|Fast|which version|selected (model|checkpoint))\b[^\n]*/gi
        ) ?? []
      )
        .filter((l) => /\bvariant\b|\bwhich version\b|selected (model|checkpoint)/i.test(l))
        .slice(0, 2),
  },
  {
    id: 'PARAMS-IN-PROMPT',
    severity: 'warn',
    why: 'Aspect ratio / resolution / steps are form fields. Observed being written into enhancedPrompt as text.',
    test: ({ prompt }) => {
      const mentions = /aspect ratio|resolution|megapixel|step count/i.test(prompt);
      const guarded =
        /chosen in the form|never write .* (into|in) the prompt|not written into the prompt|form field/i.test(
          prompt
        );
      return mentions && !guarded
        ? ['mentions ratio/resolution with no "not in the prompt" guard']
        : null;
    },
  },
  {
    id: 'BARE-PROHIBITION',
    severity: 'info',
    why: 'F2: a prohibition with no positive replacement makes the model invent the substitute. The good guides pair every "no X" with the phrasing that replaces it.',
    test: ({ prompt }) => {
      const prohibits = /\bNO\b|\bdoes NOT\b|\bnot supported\b|\bignored\b|\bavoid\b/.test(prompt);
      const pairs = /instead of|rather than|instead,|replace .* with|say ["“]/i.test(prompt);
      return prohibits && !pairs ? ['prohibits without showing the replacement'] : null;
    },
  },
  {
    id: 'MISSING-TRAILERS',
    severity: 'bug',
    why: 'The two closing Guidelines bullets are load-bearing for output shape and must be verbatim in every guide.',
    test: ({ prompt }) => {
      const miss = [];
      if (!/Limit recommendations to the 3 most impactful improvements/.test(prompt))
        miss.push('missing 3-recommendation cap');
      // Edit-focused guides legitimately say "ready-to-use edit instruction" instead of
      // "prompt" — flux1kontext does, and that is the correct noun for an edit model.
      if (!/single, ready-to-use [\w ]*?that stays faithful/.test(prompt))
        miss.push('missing ready-to-use-prompt line');
      return miss.length ? miss : null;
    },
  },
  {
    id: 'OUTPUT-SHAPE-LEAK',
    severity: 'warn',
    why: 'Output shape is owned by OutputFormatInstructions + the json_schema. A guide describing it fights the schema.',
    // "Do not write JSON-formatted prompts" is advice about the *user's* input and is correct;
    // only flag lines that describe the analyzer's own response shape.
    test: ({ prompt }) =>
      (
        prompt.match(
          /[^\n]*\b(JSON|issues array|severity|return an object|respond with)\b[^\n]*/gi
        ) ?? []
      )
        .filter(
          (l) => !/\b(prompt|tag list|booru|keyword|input|write|written|rewrite|format)\b/i.test(l)
        )
        .slice(0, 2),
  },
];

const all = filePath ? loadFromFile(filePath) : await loadLive();
const rows = all
  .filter((e) => !OUT_OF_SCOPE.has(e.ecosystem.toLowerCase()))
  .filter((e) => (onlyKey ? e.ecosystem.toLowerCase() === onlyKey.toLowerCase() : true));

/**
 * Identify "no custom guide" by the default's own opening, not by length. A length threshold
 * silently skips every check on any custom guide shorter than the cutoff — which is how a
 * self-test of the duration check came back clean against text that plainly contained the bug.
 */
const DEFAULT_OPENING = 'You are a prompt engineering expert for AI image generation';
const results = [];
for (const e of rows) {
  const prompt = e.systemPrompt ?? '';
  const isDefault = prompt.trim().startsWith(DEFAULT_OPENING);
  const ctx = { prompt, ...split(prompt) };
  const findings = isDefault
    ? [{ id: 'NO-GUIDE', severity: 'bug', detail: ['falls through to DefaultSystemPrompt'] }]
    : CHECKS.map((c) => ({ id: c.id, severity: c.severity, detail: c.test(ctx) })).filter(
        (f) => f.detail && f.detail.length
      );
  results.push({
    key: e.ecosystem,
    chars: prompt.length,
    samples: (e.samples ?? []).length,
    findings,
  });
}

const rank = { bug: 0, warn: 1, info: 2 };
const score = (r) => r.findings.reduce((a, f) => a + (3 - rank[f.severity]), 0);
results.sort((a, b) => score(b) - score(a));

if (onlyKey) {
  for (const r of results) {
    console.log(`\n### ${r.key}  (${r.chars} chars, ${r.samples} samples)`);
    for (const f of r.findings) {
      const c = CHECKS.find((x) => x.id === f.id);
      console.log(`\n  [${f.severity.toUpperCase()}] ${f.id}`);
      if (c) console.log(`  ${c.why}`);
      f.detail.forEach((d) => console.log(`    > ${String(d).trim().slice(0, 160)}`));
    }
    if (!r.findings.length) console.log('  clean');
  }
} else {
  const ids = CHECKS.map((c) => c.id);
  console.log(`${'ecosystem'.padEnd(22)}${ids.map((i) => i.slice(0, 6).padEnd(7)).join('')}`);
  console.log('-'.repeat(22 + ids.length * 7));
  for (const r of results) {
    const cells = ids.map((id) => {
      const f = r.findings.find((x) => x.id === id);
      return (
        f ? (f.severity === 'bug' ? 'BUG' : f.severity === 'warn' ? 'warn' : 'info') : '·'
      ).padEnd(7);
    });
    const noGuide = r.findings.some((f) => f.id === 'NO-GUIDE');
    console.log(`${(r.key + (noGuide ? ' *' : '')).padEnd(22)}${cells.join('')}`);
  }
  console.log(`\n* = no custom guide (on DefaultSystemPrompt)`);
  const tally = {};
  results.forEach((r) => r.findings.forEach((f) => (tally[f.id] = (tally[f.id] ?? 0) + 1)));
  console.log('\ntotals:');
  Object.entries(tally)
    .sort((a, b) => b[1] - a[1])
    .forEach(([k, v]) => console.log(`  ${k.padEnd(30)} ${v}`));
  console.log(`\n${results.length} in-scope ecosystems audited. Use --key <name> for detail.`);
}
