#!/usr/bin/env node
/**
 * Apply the mechanical corpus fixes to every live guide and write candidates to disk.
 *
 * Only transformations that are safe without measurement:
 *
 *  1. DELETE hardcoded Duration/FPS bullets. Duration is a generation parameter, not prompt
 *     content (decided 2026-08-06), and the analyzer is never told the real value — so the
 *     bullet is at best inert and at worst teaches a wrong number.
 *  2. MOVE absence-check guidelines into the rules block, rephrased as properties of the
 *     rewrite. A guideline whose trigger is "the prompt lacks X" fires on nearly every
 *     request and consumes the 3-recommendation cap; the same instruction in the rules block
 *     shapes the rewrite without claiming a slot. This is the change that took minimaxh3's
 *     camera/audio from 98% to 65% and sdxl's lighting from 92% to 66%.
 *  3. ADD a "chosen in the form" guard where a guide names aspect ratio / resolution without
 *     one, since those were observed being written into enhancedPrompt as text.
 *
 * Everything else in the audit needs judgement and is done by hand.
 *
 *   node rewrite.mjs --file <export.json> --out docs/prompt-analysis-samples/candidates
 *   node rewrite.mjs --file <export.json> --key flux1 --dry
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { resolve, join } from 'node:path';

const args = process.argv.slice(2);
const flag = (n) => {
  const i = args.indexOf(`--${n}`);
  return i === -1 ? undefined : args[i + 1];
};
const filePath = flag('file');
const outDir = flag('out');
const onlyKey = flag('key');
const dry = args.includes('--dry');

const DEFAULT_OPENING = 'You are a prompt engineering expert for AI image generation';
const OUT_OF_SCOPE = new Set(['ace', 'tripo', 'hunyuan3d', 'polygen']);
/**
 * Keys with no generation support, so nothing ever submits them. `wanvideo`'s support entry is
 * commented out in basemodel.constants with the note "This shouldn't ever apply".
 * NOTE: `ltxv` is NOT in this set — it has its own generation support, base model, and no
 * parentEcosystemId, so it reaches prompt analysis as `ltxv`. It was wrongly excluded once.
 */
const UNREACHABLE = new Set(['wanvideo']);

const DURATION_BULLET = /^-\s*(Duration|Length|Clip length|FPS)\b[^\n]*\n?/gim;
const ABSENCE_GUIDELINE =
  /^-\s*(Flag|Suggest|Identify|Ensure|Check)\b[^\n]*\b(missing|absent|lack\w*|if none|when none|unspecified)\b[^\n]*\n?/gim;
/**
 * Guidelines that reference a clip length. Deleting the Duration rule while leaving these
 * behind is worse than doing neither: the guideline now points at a fact the guide no longer
 * states, and the analyzer never had the real value to check against in the first place.
 */
const DURATION_GUIDELINE = /^-\s*[^\n]*\b\d+\s*[–-]\s*\d+\s*(second|sec|s)\b[^\n]*\n?/gim;

/**
 * A `Duration:` bullet usually carries two things: a spec number the analyzer can't act on,
 * and genuine prompting advice ("keep to one continuous action", "gradual progression rather
 * than discrete scene changes"). Deleting the whole bullet throws the second away — on veo3 it
 * removed the guide's only positive-replacement pairing. Keep the advice, drop the numbers.
 */
function salvageFromDuration(bullet) {
  const body = bullet.replace(/^-\s*(Duration|Length|Clip length|FPS)\b\s*:?\s*/i, '').trim();
  const kept = body
    .split(/(?<=[.!])\s+/)
    .map((s) => s.trim())
    .filter((s) => s && !/\d/.test(s))
    .filter((s) => /rather than|instead|describe|keep |prefer|single|continuous|avoid/i.test(s));
  return kept.length ? `- Shot structure: ${kept.join(' ')}` : '';
}

/**
 * Rephrase a "Flag missing X" guideline as a property of the rewrite — but ONLY for the
 * unambiguous shape. A blunter version of this mangled six guides: it inverted
 * "Identify vague descriptions" into "the prompt should carry vague descriptions", inverted
 * "Flag artist references missing the @ prefix" into an instruction to include broken
 * references, and shredded a couple of others into ungrammatical fragments. Anything with a
 * precondition, an embedded second clause, or a non-"missing" verb is left alone and reported
 * for hand review — a mangled rule is worse than the absence-check it replaced.
 */
function toRewriteProperty(line) {
  const raw = line.replace(/^-\s*/, '').trim();

  // "Identify …" means detect-and-report; rewriting it as a rewrite property inverts it.
  if (/^Identify\b/i.test(raw)) return null;
  // A second clause ("… , and flag …") cannot be folded into one property.
  if (/,\s*(and|or)\s+flag\b/i.test(raw)) return null;
  // A precondition means the guideline is already prompt-conditional and belongs where it is.
  if (/\bthat (is|are)\b|\bwhen the prompt\b|-family\b|\bduring\b/i.test(raw)) return null;

  const m = raw.match(
    /^(?:Flag|Suggest|Ensure|Check)\s+(?:missing\s+)?(.+?)(?:\s+(?:if|when)\s+(?:none\s+(?:is|are)\s+present|missing|unspecified|not\s+\w+))?\.?$/i
  );
  if (!m) return null;
  let body = m[1].trim().replace(/^(missing|absent)\s+/i, '');
  // Leading gerunds read wrong after "should carry".
  body = body.replace(/^adding\s+/i, '');
  if (!body || /^or\b/i.test(body)) return null;

  return `- The enhanced prompt should carry ${
    body.charAt(0).toLowerCase() + body.slice(1)
  }. This shapes the rewrite; do not raise it as a separate recommendation.`;
}

const PARAM_GUARD =
  '- Aspect ratio, resolution, and step count are chosen in the form. Never write them into the prompt text.';

/**
 * `Prompt template:` is conventionally the last rule and reads as a summary of everything
 * above it, so new rules go before it rather than after.
 */
function insertIntoRules(rules, block) {
  const lines = rules.replace(/\n+$/, '').split('\n');
  const at = lines.findIndex((l) => /^-\s*Prompt template:/i.test(l));
  if (at === -1) return lines.join('\n') + '\n' + block + '\n\n';
  lines.splice(at, 0, ...block.split('\n'));
  return lines.join('\n') + '\n\n';
}

function transform(prompt) {
  const gi = prompt.search(/^Guidelines:/m);
  if (gi === -1) return { prompt, changes: [] };
  let rules = prompt.slice(0, gi);
  let guidelines = prompt.slice(gi);
  const changes = [];

  const durations = rules.match(DURATION_BULLET) ?? [];
  if (durations.length) {
    let salvaged = 0;
    rules = rules.replace(DURATION_BULLET, (bullet) => {
      const kept = salvageFromDuration(bullet);
      if (kept) salvaged++;
      return kept ? kept + '\n' : '';
    });
    changes.push(
      `duration bullets: ${durations.length} stripped${salvaged ? `, ${salvaged} salvaged` : ''}`
    );
  }

  const orphans = guidelines.match(DURATION_GUIDELINE) ?? [];
  if (orphans.length) {
    guidelines = guidelines.replace(DURATION_GUIDELINE, '');
    changes.push(`deleted ${orphans.length} duration-referencing guideline(s)`);
  }

  const absences = guidelines.match(ABSENCE_GUIDELINE) ?? [];
  if (absences.length) {
    const moved = [];
    const skipped = [];
    for (const line of absences) {
      const rewritten = toRewriteProperty(line);
      if (rewritten) {
        moved.push(rewritten);
        guidelines = guidelines.replace(line, '');
      } else {
        skipped.push(line.replace(/^-\s*/, '').trim());
      }
    }
    if (moved.length) {
      rules = insertIntoRules(rules, moved.join('\n'));
      changes.push(`moved ${moved.length} absence-check(s) into rules`);
    }
    if (skipped.length) {
      changes.push(`NEEDS HAND REVIEW: ${skipped.length} absence-check(s) too complex to rephrase`);
      skipped.forEach((s) => changes.push(`      > ${s.slice(0, 130)}`));
    }
  }

  // The params guard is DISABLED. It was meant to stop aspect ratio / resolution leaking into
  // enhancedPrompt, but naming those topics in the rules block makes the model recommend them:
  // on grok and auraflow, adding this single line was the only change and saturation went
  // 1 -> 3 and 0 -> 1. Same effect seen earlier on mai. If a guide genuinely leaks parameters,
  // fix it with a sample, not a prohibition.

  return { prompt: (rules + guidelines).replace(/\n{3,}/g, '\n\n').trimEnd() + '\n', changes };
}

const raw = JSON.parse(readFileSync(resolve(filePath), 'utf8'));
const all = (raw.ecosystems ?? raw).filter(
  (e) =>
    !OUT_OF_SCOPE.has(e.ecosystem.toLowerCase()) &&
    !UNREACHABLE.has(e.ecosystem.toLowerCase()) &&
    !(e.systemPrompt ?? '').trim().startsWith(DEFAULT_OPENING) &&
    (onlyKey ? e.ecosystem.toLowerCase() === onlyKey.toLowerCase() : true)
);

if (outDir && !dry) mkdirSync(resolve(outDir), { recursive: true });

let touched = 0;
for (const e of all) {
  const { prompt, changes } = transform(e.systemPrompt ?? '');
  // Write every guide when --out is given, changed or not. Writing only the changed ones let
  // an authored override vanish: the build script layers authored files over the live-derived
  // ones, and a clean authored guide produced no file, so the stale live version survived.
  if (!changes.length) {
    if (outDir && !dry) writeFileSync(join(resolve(outDir), `${e.ecosystem}.txt`), prompt);
    continue;
  }
  touched++;
  console.log(`${e.ecosystem.padEnd(22)} ${changes.join('; ')}`);
  if (onlyKey || dry) {
    console.log('\n' + prompt + '\n' + '-'.repeat(70));
  }
  if (outDir && !dry) writeFileSync(join(resolve(outDir), `${e.ecosystem}.txt`), prompt);
}
console.log(
  `\n${touched}/${all.length} guides changed${
    outDir && !dry ? ` — written to ${outDir}` : ' (dry run)'
  }`
);
