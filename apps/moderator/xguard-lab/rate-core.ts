/**
 * AI baseline rating pass: judge unrated samples in a batch for one label.
 *
 * The rater is the baseline a human confirms, never the final answer. Prompts are long and the deciding
 * term is easy to miss, so the model reads carefully once and returns the exact spans it judged on —
 * those become the review UI's highlights, which is the difference between re-reading 800 tokens and
 * glancing at three highlighted words.
 *
 * Owns its own `pg` connection from a connection string, like eval-core, so the CLI and a SvelteKit route
 * can both call it without agreeing on a database library.
 */
import pg from 'pg';
import { LABELS, type LabName } from './labels';

export type RateOptions = {
  connectionString: string;
  batch: string;
  label: LabName;
  model?: string;
  fallbackModel?: string;
  concurrency?: number;
  /** Cap the number of samples rated in this pass. Omit for every unrated sample in the batch. */
  limit?: number;
  /** Supply when the caller reads env some other way than `process.env` (the SvelteKit routes do). */
  openrouterKey?: string;
  onProgress?: (done: number, total: number) => void;
};

export type RateSummary = {
  batch: string;
  label: string;
  model: string;
  fallbackModel: string;
  /** Unrated samples this pass picked up. Zero means the batch is already fully rated for this label. */
  candidates: number;
  rated: number;
  failed: number;
  /** Refused by the primary model and retried on the fallback. Counted, never recorded as a verdict. */
  refused: number;
  /** AI verdicts across the WHOLE batch for this label, not just this pass. */
  verdicts: { true: number; false: number };
  /** First few failures, so a caller sees why rather than only how many. */
  errors: string[];
};

export const DEFAULT_MODEL = 'xiaomi/mimo-v2.5';
export const DEFAULT_FALLBACK_MODEL = 'deepseek/deepseek-v4-flash';

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
  key: string;
}): Promise<Rating> {
  const def = LABELS[args.label];

  const system = `You judge image-generation prompts for a single label. Answer only for the label described; ignore every other concern.

LABEL: ${args.label}
${def.rubric}

The prompt may be hundreds of tokens of style boilerplate with the deciding term buried in it, in a non-English section, or inside a LoRA or embedding filename. Read all of it.

A term appearing ONLY in the negative prompt is an exclusion. The user is asking to avoid it, so it must never make the verdict true.

Reply with JSON only:
{"verdict": <true|false>, "reason": "<one or two sentences>", "spans": ["<exact substring you judged on>", ...]}

Every span must be an exact substring of the prompt text, copied character for character. Return an empty array when nothing in the prompt is relevant.`;

  const user = `POSITIVE PROMPT:\n${args.positivePrompt}\n\nNEGATIVE PROMPT:\n${
    args.negativePrompt ?? '(none)'
  }`;

  const res = await fetch('https://openrouter.ai/api/v1/chat/completions', {
    method: 'POST',
    headers: { Authorization: `Bearer ${args.key}`, 'Content-Type': 'application/json' },
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

const MAX_REPORTED_ERRORS = 5;

export async function rateBatch(opts: RateOptions): Promise<RateSummary> {
  const key = opts.openrouterKey ?? process.env.OPENROUTER_API_KEY;
  if (!key) throw new Error('OPENROUTER_API_KEY not set');
  if (!LABELS[opts.label]) {
    throw new Error(`unknown label "${opts.label}" (have: ${Object.keys(LABELS).join(', ')})`);
  }

  const model = opts.model ?? DEFAULT_MODEL;
  const fallbackModel = opts.fallbackModel ?? DEFAULT_FALLBACK_MODEL;
  const client = new pg.Client({ connectionString: opts.connectionString });
  await client.connect();

  try {
    await client.query(
      `INSERT INTO label_def (name, description) VALUES ($1, $2) ON CONFLICT (name) DO NOTHING`,
      [opts.label, LABELS[opts.label].description]
    );

    const { rows } = await client.query<{
      id: string;
      positive_prompt: string;
      negative_prompt: string | null;
    }>(
      `SELECT s.id::text, s.positive_prompt, s.negative_prompt
         FROM sample s
        WHERE s.batch = $1
          AND NOT EXISTS (
            SELECT 1 FROM machine_judgement m
             WHERE m.sample_id = s.id AND m.label = $2 AND m.source = 'ai'
          )
        ORDER BY s.id
        LIMIT $3::int`,
      [opts.batch, opts.label, opts.limit ?? null]
    );

    let next = 0;
    let done = 0;
    let rated = 0;
    let failed = 0;
    let refused = 0;
    const errors: string[] = [];

    await Promise.all(
      Array.from(
        { length: Math.min(opts.concurrency ?? 6, Math.max(rows.length, 1)) },
        async () => {
          for (;;) {
            const i = next++;
            if (i >= rows.length) return;
            const row = rows[i];
            try {
              const call = (m: string) =>
                rate({
                  positivePrompt: row.positive_prompt,
                  negativePrompt: row.negative_prompt,
                  label: opts.label,
                  model: m,
                  key,
                });
              let usedModel = model;
              let r;
              try {
                r = await call(model);
              } catch (err) {
                if (!(err instanceof RaterRefusal)) throw err;
                refused++;
                usedModel = fallbackModel;
                r = await call(fallbackModel);
              }
              await client.query(
                `INSERT INTO machine_judgement (sample_id, label, source, model, verdict, reason, highlights)
               VALUES ($1, $2, 'ai', $3, $4, $5, $6)`,
                [
                  row.id,
                  opts.label,
                  usedModel,
                  r.verdict,
                  r.reason,
                  JSON.stringify({
                    positive: offsetsFor(row.positive_prompt, r.spans),
                    negative: offsetsFor(row.negative_prompt ?? '', r.spans),
                  }),
                ]
              );
              rated++;
            } catch (err) {
              failed++;
              if (errors.length < MAX_REPORTED_ERRORS) {
                errors.push(`sample ${row.id}: ${(err as Error).message}`);
              }
            }
            done++;
            opts.onProgress?.(done, rows.length);
          }
        }
      )
    );

    const { rows: summary } = await client.query<{ verdict: boolean; n: string }>(
      `SELECT verdict, count(*) AS n FROM machine_judgement
        WHERE label = $1 AND source = 'ai'
          AND sample_id IN (SELECT id FROM sample WHERE batch = $2)
        GROUP BY verdict`,
      [opts.label, opts.batch]
    );
    const tally = (v: boolean) => Number(summary.find((s) => s.verdict === v)?.n ?? 0);

    return {
      batch: opts.batch,
      label: opts.label,
      model,
      fallbackModel,
      candidates: rows.length,
      rated,
      failed,
      refused,
      verdicts: { true: tally(true), false: tally(false) },
      errors,
    };
  } finally {
    await client.end();
  }
}
