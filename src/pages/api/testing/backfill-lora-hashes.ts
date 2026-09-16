/**
 * Backfill for the A1111 "Lora hashes" regression (ClickUp 868m53cpr).
 *
 * Between 2026-08-31 and the @civitai/generation-metadata 0.3.0 upgrade, a `Lora
 * hashes` block whose FIRST entry carried an awkward character (brackets, non-Latin
 * script) failed the parser's shape test, unquoted to a plain string, and was then
 * iterated character by character — so `meta.hashes` gained one `lora:<n>` key per
 * CHARACTER and the whole block's LoRAs went undetected.
 *
 * Those rows repair in place: the `lora:0`, `lora:1` … values ARE the original block,
 * in order. This reassembles it, re-parses it with the shipped (fixed) parser, rewrites
 * `meta.hashes` / `meta.resources`, and re-runs detection.
 *
 * GET /api/testing/backfill-lora-hashes?token=$WEBHOOK_TOKEN
 *   from=          absolute start, e.g. from=2026-09-14. Takes precedence over days; use it
 *                  when the window is anchored to an event rather than to "now", since a
 *                  days-back window silently shifts every time you re-run it.
 *   days=14        how far back to scan (createdAt >= now() - days). Default 14.
 *   batchSize=100  images per batch, max 500.
 *   maxBatches=0   0 = keep going until the window is exhausted or maxMs runs out.
 *   maxMs=240000   stop cleanly before the platform's request timeout and hand back a
 *                  cursor. Resume with after=<nextCursor> from the response.
 *   after=         resume point, `<iso createdAt>|<id>` from a previous response.
 *   apply=false    DRY RUN unless apply=true. Nothing is written without it.
 *   concurrency=10 images repaired in parallel, max 25. Each repair is ~650ms of mostly
 *                  waiting (update, delete, re-detect, cache bust), so serial apply runs
 *                  at ~100 images/minute and the window takes hours.
 *   userId=<id>    optional: restrict to one uploader.
 *   verbose=false  include a per-image sample of what would change.
 *
 * Reads the fixed parser through `parsePromptMetadata`, deliberately: the backfill and
 * the upload path must not be able to disagree about what a block means. That also means
 * this endpoint is only correct once the app is on a build with the fix.
 *
 * Paging is keyset on (createdAt, id) because that is the index the filter walks
 * (`Image_createdAt_id`). Ordering by id alone makes every batch re-scan the window from
 * the start — measured at 403k rows filtered to find the first 100, and quadratic from
 * there. There is no index that can serve the `meta` LIKE, so the scan is the cost; the
 * point of the keyset is that it is paid once, not once per batch.
 */
import type { NextApiRequest, NextApiResponse } from 'next';
import pLimit from 'p-limit';
import { Prisma } from '@prisma/client';
import { dbRead, dbWrite } from '~/server/db/client';
import { refreshImageResources } from '~/server/services/image.service';
import { parsePromptMetadata } from '~/utils/metadata';
import { WebhookEndpoint } from '~/server/utils/endpoint-helpers';

const CHAR_SPLIT_KEY = /^lora:\d+$/;
const MAX_BATCH = 500;

type ImageRow = { id: number; createdAt: Date; meta: Record<string, any> | null };

/** The `lora:<n>` values are the original block's characters, in index order. */
function reassembleBlock(hashes: Record<string, unknown>): string {
  const chars: string[] = [];
  for (const [key, value] of Object.entries(hashes)) {
    const match = /^lora:(\d+)$/.exec(key);
    if (match && typeof value === 'string') chars[Number(match[1])] = value;
  }
  // A hole means the row is not what we think it is; refuse rather than guess.
  return chars.length && [...chars].every((c) => typeof c === 'string') ? chars.join('') : '';
}

function recoverLoraHashes(block: string): Record<string, string> | null {
  // The block sits inside a quoted A1111 value, so an embedded quote is not something
  // this format can represent — treat it as unrecognized input rather than repair it.
  if (!block || block.includes('"')) return null;
  const meta = parsePromptMetadata(`backfill\nSteps: 1, Lora hashes: "${block}"`);
  const hashes = (meta?.hashes ?? {}) as Record<string, string>;
  const recovered: Record<string, string> = {};
  for (const [key, value] of Object.entries(hashes)) {
    if (key.startsWith('lora:') && !CHAR_SPLIT_KEY.test(key)) recovered[key] = value;
  }
  return Object.keys(recovered).length ? recovered : null;
}

/** `{type:'lora', name:'17', hash:'e'}` — one bogus resource per character. */
function isCharSplitResource(resource: unknown): boolean {
  const r = resource as { name?: unknown; hash?: unknown };
  return (
    typeof r?.name === 'string' &&
    /^\d+$/.test(r.name) &&
    typeof r?.hash === 'string' &&
    r.hash.length === 1
  );
}

function parseAfter(value: unknown): { createdAt: Date; id: number } | null {
  if (typeof value !== 'string' || !value.includes('|')) return null;
  const [iso, id] = value.split('|');
  const createdAt = new Date(iso);
  if (Number.isNaN(createdAt.getTime()) || !Number(id)) return null;
  return { createdAt, id: Number(id) };
}

export default WebhookEndpoint(async function handler(req: NextApiRequest, res: NextApiResponse) {
  const days = Math.min(Number(req.query.days ?? 14) || 14, 120);
  const batchSize = Math.min(Number(req.query.batchSize ?? 100) || 100, MAX_BATCH);
  const maxBatches = Number(req.query.maxBatches ?? 0) || 0;
  const maxMs = Math.min(Number(req.query.maxMs ?? 240_000) || 240_000, 280_000);
  const apply = req.query.apply === 'true';
  const userId = req.query.userId ? Number(req.query.userId) : undefined;
  const verbose = req.query.verbose === 'true';
  const concurrency = Math.min(Math.max(Number(req.query.concurrency ?? 10) || 10, 1), 25);

  const startedAt = Date.now();
  // Computed here, not as make_interval(days => ${days}): Prisma binds a JS number as
  // int8 and make_interval takes int4, so the parameterised form fails at runtime while
  // the same SQL with a literal works. A Date binds as timestamptz and matches the column.
  const fromParam = typeof req.query.from === 'string' ? new Date(req.query.from) : null;
  const validFrom = fromParam && !Number.isNaN(fromParam.getTime()) ? fromParam : null;
  const since = validFrom ?? new Date(startedAt - days * 24 * 60 * 60 * 1000);
  const samples: unknown[] = [];
  let after = parseAfter(req.query.after);
  let batches = 0;
  let scanned = 0;
  let repaired = 0;
  let loraHashesRecovered = 0;
  let skippedUnrecoverable = 0;
  let exhausted = false;
  let stoppedOn: 'exhausted' | 'maxBatches' | 'maxMs' = 'exhausted';
  const failures: { id: number; error: string }[] = [];

  // Reject rather than fall back: a typo'd from= would silently become a 14-day window,
  // and the caller would read the resulting counts as coverage of a range never scanned.
  if (typeof req.query.from === 'string' && !validFrom)
    return res.status(400).json({ error: `from=${req.query.from} is not a date` });

  try {
    for (;;) {
      if (maxBatches && batches >= maxBatches) {
        stoppedOn = 'maxBatches';
        break;
      }
      if (Date.now() - startedAt > maxMs) {
        stoppedOn = 'maxMs';
        break;
      }

      const rows = await dbRead.$queryRaw<ImageRow[]>`
        SELECT i.id, i."createdAt", i.meta
        FROM "Image" i
        WHERE i."createdAt" >= ${since}
          ${
            after
              ? Prisma.sql`AND (i."createdAt", i.id) > (${after.createdAt}::timestamptz, ${after.id}::int)`
              : Prisma.empty
          }
          AND i.meta->>'hashes' LIKE '%"lora:0":%'
          ${userId ? Prisma.sql`AND i."userId" = ${userId}` : Prisma.empty}
        ORDER BY i."createdAt", i.id
        LIMIT ${batchSize}
      `;
      if (!rows.length) {
        exhausted = true;
        break;
      }

      batches++;
      const last = rows[rows.length - 1];
      after = { createdAt: last.createdAt, id: last.id };

      // The writes are ~650ms each and almost entirely waiting on the database, so the
      // batch runs them concurrently. Serially this is ~100 images a minute, which turns
      // the 13.6k-image window into hours and a hundred-odd hand-driven requests. The
      // cursor still advances a whole batch at a time, so an interrupted request re-reads
      // this batch rather than skipping it.
      const limit = pLimit(concurrency);
      await Promise.all(
        rows.map((row) =>
          limit(async () => {
            scanned++;
            const meta = (row.meta ?? {}) as Record<string, any>;
            const hashes = (meta.hashes ?? {}) as Record<string, string>;
            if (!Object.keys(hashes).some((k) => CHAR_SPLIT_KEY.test(k))) return;

            const recovered = recoverLoraHashes(reassembleBlock(hashes));
            if (!recovered) {
              skippedUnrecoverable++;
              return;
            }

            const cleanedHashes: Record<string, string> = {};
            for (const [key, value] of Object.entries(hashes)) {
              if (!CHAR_SPLIT_KEY.test(key)) cleanedHashes[key] = value;
            }
            const nextHashes = { ...cleanedHashes, ...recovered };
            const nextResources = Array.isArray(meta.resources)
              ? meta.resources.filter((r: unknown) => !isCharSplitResource(r))
              : meta.resources;

            if (verbose && samples.length < 10) {
              samples.push({
                id: row.id,
                charKeysRemoved: Object.keys(hashes).length - Object.keys(cleanedHashes).length,
                recovered: Object.keys(recovered),
              });
            }

            repaired++;
            loraHashesRecovered += Object.keys(recovered).length;
            if (!apply) return;

            try {
              await dbWrite.image.update({
                where: { id: row.id },
                data: { meta: { ...meta, hashes: nextHashes, resources: nextResources } },
              });
              // Drops the stale detected rows (including the ones the garbage produced)
              // and re-derives them from the repaired meta.
              await refreshImageResources(row.id);
            } catch (e) {
              failures.push({ id: row.id, error: (e as Error).message });
            }
          })
        )
      );
    }

    return res.status(200).json({
      mode: apply ? 'APPLIED' : 'DRY RUN (pass apply=true to write)',
      window: validFrom ? `from ${validFrom.toISOString()}` : `${days} days`,
      userId: userId ?? 'all',
      stoppedOn,
      exhausted,
      nextCursor: exhausted || !after ? null : `${after.createdAt.toISOString()}|${after.id}`,
      batches,
      batchSize,
      concurrency,
      scanned,
      repaired,
      loraHashesRecovered,
      skippedUnrecoverable,
      failureCount: failures.length,
      failures: failures.slice(0, 20),
      elapsedMs: Date.now() - startedAt,
      ...(verbose ? { samples } : {}),
    });
  } catch (error) {
    return res.status(500).json({
      error: (error as Error).message,
      progress: {
        batches,
        scanned,
        repaired,
        resumeFrom: after ? `${after.createdAt.toISOString()}|${after.id}` : null,
      },
    });
  }
});
