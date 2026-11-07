import { createHash } from 'crypto';
import { appendFileSync, readFileSync, writeFileSync } from 'fs';
import { parseArgs } from 'util';

import { dbRead } from '~/server/db/client';
import { comFaceIntentFields, getOwnTriggerWords } from '~/server/services/model-sfw-face.service';
import { getActiveTextScanPrompts } from '~/server/services/text-scan/prompt';
import { previewTextScanLabel } from '~/server/services/text-scan/preview';
import type { TextScanField } from '~/server/services/text-scan/types';
import { runScriptAndExit } from './lib/run-as-script';

/**
 * Score a text-scan label prompt against a set of items, N runs each, through the same compose,
 * submit, parse and merge path as the live preview (no callback, no entity, no moderation record).
 *
 *   pnpm run tsscript scripts/eval-text-scan-label.ts --set <file> --out <file.jsonl>
 *       [--label model-com-face-intent] [--runs 3] [--tag current] [--override <file>]
 *       [--concurrency 4]
 *   pnpm run tsscript scripts/eval-text-scan-label.ts --dump-active <file>
 *
 * --set: JSON array or JSON lines; leading non-JSON lines (a query tool's header) are skipped.
 *   An item is `{ id: <modelId>, b?: <bucket> }`, read as the .com face gate reads the listing
 *   (title, description and the owner's trigger words, together), or
 *   `{ key: <string>, b?: <bucket>, fields: [{ heading, text }] }` for raw text.
 * --override: a file whose whole content replaces the active `label:<label>` prompt for this run.
 *   Without it the active row is used.
 * --dump-active: writes the active `label:<label>` row (id and content) to a file and exits.
 *
 * Verdicts and reasons go to --out only; stdout prints item keys, buckets and counts. Keep the set,
 * the override and the output outside the repo: they hold listing text and prompt text.
 */

type Item =
  | { key: string; b: string; fields: TextScanField[] }
  | { key: string; b: string; modelId: number };
type Verdict = 'detected' | 'allowed' | 'unavailable' | 'missing';

const WAIT_SECONDS = 60;

function readSet(path: string): Item[] {
  const lines = readFileSync(path, 'utf8').split(/\r?\n/);
  const start = lines.findIndex((line) => /^\s*[[{]/.test(line));
  if (start < 0) throw new Error(`${path}: no JSON found`);
  const body = lines.slice(start).join('\n').trim();
  const rows: Record<string, unknown>[] = body.startsWith('[')
    ? JSON.parse(body)
    : body
        .split('\n')
        .filter((line) => line.trim())
        .map((line) => JSON.parse(line));
  return rows.map((row, i) => {
    const b = typeof row.b === 'string' ? row.b : '';
    if (Array.isArray(row.fields))
      return { key: String(row.key ?? `raw-${i}`), b, fields: row.fields as TextScanField[] };
    const modelId = Number(row.id);
    if (!Number.isInteger(modelId)) throw new Error(`${path} row ${i}: no model id or fields`);
    return { key: String(modelId), b, modelId };
  });
}

async function gateFields(modelId: number): Promise<TextScanField[] | null> {
  const model = await dbRead.model.findUnique({
    where: { id: modelId },
    select: { name: true, description: true, userId: true },
  });
  if (!model) return null;
  const triggerWords = await getOwnTriggerWords({ modelId, userId: model.userId });
  return comFaceIntentFields({ name: model.name, description: model.description, triggerWords });
}

async function pool<T>(items: T[], size: number, run: (item: T) => Promise<void>) {
  const queue = [...items];
  await Promise.all(
    Array.from({ length: size }, async () => {
      for (let item = queue.shift(); item !== undefined; item = queue.shift()) await run(item);
    })
  );
}

const sha = (text: string) => createHash('sha256').update(text).digest('hex').slice(0, 12);

async function main() {
  const { values } = parseArgs({
    options: {
      set: { type: 'string' },
      out: { type: 'string' },
      label: { type: 'string', default: 'model-com-face-intent' },
      runs: { type: 'string', default: '3' },
      tag: { type: 'string' },
      override: { type: 'string' },
      concurrency: { type: 'string', default: '4' },
      'dump-active': { type: 'string' },
    },
  });
  const label = values.label as 'model-com-face-intent';
  const promptKey = `label:${label}`;
  const active = (await getActiveTextScanPrompts())[promptKey];

  if (values['dump-active']) {
    if (!active) throw new Error(`no active ${promptKey} row`);
    writeFileSync(values['dump-active'], JSON.stringify(active, null, 2));
    console.log(`wrote ${promptKey} row ${active.id} (sha ${sha(active.content)})`);
    return;
  }
  if (!values.set || !values.out) throw new Error('--set and --out are required');

  const override = values.override ? readFileSync(values.override, 'utf8') : undefined;
  const tag = values.tag ?? (override ? 'override' : 'active');
  const runs = Number(values.runs);
  const items = readSet(values.set);
  console.log(
    `${tag}: ${promptKey} ${
      override
        ? `override sha ${sha(override)}`
        : `active row ${active?.id} sha ${active ? sha(active.content) : 'none'}`
    }; ` + `${items.length} items x ${runs} runs`
  );

  const tallies = new Map<string, Verdict[]>();
  const jobs = items.flatMap((item) => Array.from({ length: runs }, (_, run) => ({ item, run })));
  const fieldsCache = new Map<string, Promise<TextScanField[] | null>>();
  const fieldsOf = (item: Item) => {
    if ('fields' in item) return Promise.resolve(item.fields);
    if (!fieldsCache.has(item.key)) fieldsCache.set(item.key, gateFields(item.modelId));
    return fieldsCache.get(item.key) as Promise<TextScanField[] | null>;
  };

  await pool(jobs, Number(values.concurrency), async ({ item, run }) => {
    const fields = await fieldsOf(item);
    let verdict: Verdict = 'missing';
    let reason = '';
    if (fields) {
      const result = await previewTextScanLabel({
        label,
        fields,
        waitSeconds: WAIT_SECONDS,
        promptOverrides: override ? { [promptKey]: override } : {},
      }).catch((error) => {
        reason = error instanceof Error ? error.message : String(error);
        return { status: 'unavailable' as const };
      });
      if (result.status === 'ok') {
        verdict = result.output.detected ? 'detected' : 'allowed';
        reason = result.output.reason;
      } else verdict = 'unavailable';
    }
    appendFileSync(
      values.out as string,
      JSON.stringify({ tag, key: item.key, b: item.b, run, verdict, reason }) + '\n'
    );
    tallies.set(item.key, [...(tallies.get(item.key) ?? []), verdict]);
  });

  for (const item of items) {
    const verdicts = tallies.get(item.key) ?? [];
    const count = (v: Verdict) => verdicts.filter((x) => x === v).length;
    console.log(
      `${tag}\t${item.key}\t${item.b}\tR${count('detected')} A${count('allowed')} U${count(
        'unavailable'
      )}` + (count('missing') ? ` MISSING${count('missing')}` : '')
    );
  }
}

runScriptAndExit(main);
