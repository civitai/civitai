/**
 * AI baseline rating pass: judge every unrated sample in a batch for a label.
 *
 *   pnpm exec tsx --env-file=.env apps/moderator/xguard-lab/rate.ts \
 *     --batch 2026-08-04-age --label AgeAsserted
 *
 * The rater is the baseline a human confirms rather than the final answer.
 * Prompts are long and the deciding term is easy to miss, so the model reads
 * carefully once and the reviewer only has to agree or disagree.
 *
 * It must return the exact spans it judged on. Those become the highlights in
 * the review UI, which is the difference between a reviewer re-reading 800
 * tokens and glancing at three highlighted words.
 *
 * Runs against OpenRouter. Writes to the lab DB only.
 */
import pg from 'pg';
import { LABELS, type LabName } from './labels';

type Args = { batch: string; label: LabName; model: string; fallbackModel: string; concurrency: number; limit?: number; labDb: string };

function parseArgs(argv: string[]): Args {
  const get = (f: string) => {
    const i = argv.indexOf(f);
    return i === -1 ? undefined : argv[i + 1];
  };
  const batch = get('--batch');
  const label = get('--label') as LabName | undefined;
  if (!batch) throw new Error('--batch is required');
  if (!label || !LABELS[label]) {
    throw new Error(`--label must be one of: ${Object.keys(LABELS).join(', ')}`);
  }
  return {
    batch,
    label,
    model: get('--model') ?? 'xiaomi/mimo-v2.5',
    fallbackModel: get('--fallback-model') ?? 'deepseek/deepseek-v4-flash',
    concurrency: Number(get('--concurrency') ?? 6),
    limit: get('--limit') ? Number(get('--limit')) : undefined,
    labDb:
      get('--lab-db') ??
      process.env.MODERATOR_DATABASE_URL ??
      'postgres://xguard:xguard@localhost:5433/xguard_lab',
  };
}

class RaterRefusal extends Error {
  constructor(sample: string) {
    super(`rater refused: ${sample}`);
    this.name = 'RaterRefusal';
  }
}

type Rating = { verdict: boolean; reason: string; spans: string[] };

async function rate(args: {
  positivePrompt: string;
  negativePrompt: string | null;
  label: LabName;
  model: string;
}): Promise<Rating> {
  const key = process.env.OPENROUTER_API_KEY;
  if (!key) throw new Error('OPENROUTER_API_KEY not set');
  const def = LABELS[args.label];

  const system = `You judge image-generation prompts for a single label. Answer only for the label described; ignore every other concern.

LABEL: ${args.label}
${def.rubric}

The prompt may be hundreds of tokens of style boilerplate with the deciding term buried in it, in a non-English section, or inside a LoRA or embedding filename. Read all of it.

A term appearing ONLY in the negative prompt is an exclusion. The user is asking to avoid it, so it must never make the verdict true.

Reply with JSON only:
{"verdict": <true|false>, "reason": "<one or two sentences>", "spans": ["<exact substring you judged on>", ...]}

Every span must be an exact substring of the prompt text, copied character for character. Return an empty array when nothing in the prompt is relevant.`;

  const user = `POSITIVE PROMPT:\n${args.positivePrompt}\n\nNEGATIVE PROMPT:\n${args.negativePrompt ?? '(none)'}`;

  const res = await fetch('https://openrouter.ai/api/v1/chat/completions', {
    method: 'POST',
    headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: args.model,
      temperature: 0,
      response_format: { type: 'json_object' },
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: user },
      ],
    }),
  });
  if (!res.ok) throw new Error(`openrouter ${res.status}: ${(await res.text()).slice(0, 300)}`);

  const json = (await res.json()) as { choices?: Array<{ message?: { content?: string } }> };
  const content = json.choices?.[0]?.message?.content;
  if (!content) throw new Error('no content in openrouter response');

  const cleaned = content.replace(/^```(?:json)?|```$/g, '').trim();
  // Safety-tuned raters refuse outright on some of this material and answer in prose. That is a
  // refusal, not a malformed response, and it must not be recorded as a verdict - defaulting a
  // refusal to false would quietly bias the training set on exactly the worst prompts.
  if (!cleaned.startsWith('{')) throw new RaterRefusal(cleaned.slice(0, 120));

  const parsed = JSON.parse(cleaned) as Partial<Rating>;
  return {
    verdict: Boolean(parsed.verdict),
    reason: String(parsed.reason ?? ''),
    // Drop hallucinated spans rather than highlighting text that is not there.
    spans: (parsed.spans ?? []).filter(
      (s) =>
        typeof s === 'string' &&
        s.length > 0 &&
        (args.positivePrompt.includes(s) || (args.negativePrompt ?? '').includes(s))
    ),
  };
}

/** Character offsets so the UI does not have to re-find the spans. */
function offsetsFor(text: string, spans: string[]) {
  return spans.flatMap((span) => {
    const out: Array<{ start: number; end: number; text: string }> = [];
    let from = 0;
    for (;;) {
      const at = text.indexOf(span, from);
      if (at === -1) break;
      out.push({ start: at, end: at + span.length, text: span });
      from = at + span.length;
    }
    return out;
  });
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const client = new pg.Client({ connectionString: args.labDb });
  await client.connect();

  try {
    await client.query(
      `INSERT INTO label_def (name, description) VALUES ($1, $2) ON CONFLICT (name) DO NOTHING`,
      [args.label, LABELS[args.label].description]
    );

    const { rows } = await client.query<{
      id: string;
      positive_prompt: string;
      negative_prompt: string | null;
    }>(
      `SELECT s.id, s.positive_prompt, s.negative_prompt
         FROM sample s
        WHERE s.batch = $1
          AND NOT EXISTS (
            SELECT 1 FROM machine_judgement m
             WHERE m.sample_id = s.id AND m.label = $2 AND m.source = 'ai'
          )
        ORDER BY s.id
        ${args.limit ? `LIMIT ${args.limit}` : ''}`,
      [args.batch, args.label]
    );

    console.log(`rating ${rows.length} unrated samples for ${args.label} with ${args.model}`);
    if (rows.length === 0) return;

    let next = 0;
    let done = 0;
    let failed = 0;
    let refused = 0;

    await Promise.all(
      Array.from({ length: Math.min(args.concurrency, rows.length) }, async () => {
        for (;;) {
          const i = next++;
          if (i >= rows.length) return;
          const row = rows[i];
          try {
            const call = (model: string) =>
              rate({
                positivePrompt: row.positive_prompt,
                negativePrompt: row.negative_prompt,
                label: args.label,
                model,
              });
            let usedModel = args.model;
            let r;
            try {
              r = await call(args.model);
            } catch (err) {
              if (!(err instanceof RaterRefusal)) throw err;
              refused++;
              usedModel = args.fallbackModel;
              r = await call(args.fallbackModel);
            }
            await client.query(
              `INSERT INTO machine_judgement (sample_id, label, source, model, verdict, reason, highlights)
               VALUES ($1, $2, 'ai', $3, $4, $5, $6)`,
              [
                row.id,
                args.label,
                usedModel,
                r.verdict,
                r.reason,
                JSON.stringify({
                  positive: offsetsFor(row.positive_prompt, r.spans),
                  negative: offsetsFor(row.negative_prompt ?? '', r.spans),
                }),
              ]
            );
          } catch (err) {
            failed++;
            console.error(`  sample ${row.id}: ${(err as Error).message}`);
          }
          done++;
          if (done % 25 === 0) console.log(`  ${done}/${rows.length}${failed ? ` (${failed} failed)` : ''}`);
        }
      })
    );

    const { rows: summary } = await client.query<{ verdict: boolean; n: string }>(
      `SELECT verdict, count(*) AS n FROM machine_judgement
        WHERE label = $1 AND source = 'ai'
          AND sample_id IN (SELECT id FROM sample WHERE batch = $2)
        GROUP BY verdict`,
      [args.label, args.batch]
    );
    console.log(`\n${args.label}: ${summary.map((s) => `${s.verdict ? 'true' : 'false'}=${s.n}`).join('  ')}`);
    if (refused) console.log(`${refused} refused by ${args.model}, retried on ${args.fallbackModel}`);
    if (failed) console.log(`${failed} still unrated`);
  } finally {
    await client.end();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
