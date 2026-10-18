import type { RequestHandler } from './$types';
import { audioSampleBatch } from '$lib/server/audio-review.service';

export const GET: RequestHandler = async () => {
  const to = new Date();
  const from = new Date(to.getTime() - 14 * 24 * 60 * 60_000);
  const summary = new Map<
    string,
    { status: string; flagged: boolean | null; wouldBlock: boolean | null; count: number }
  >();
  const encoder = new TextEncoder();
  let cursor = 0;
  let started = false;
  const stream = new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        if (!started) {
          started = true;
          controller.enqueue(
            encoder.encode(JSON.stringify({ type: 'window', from, to, mode: 'shadow' }) + '\n')
          );
          return;
        }
        const rows = await audioSampleBatch(from, to, cursor);
        for (const row of rows) {
          const key = JSON.stringify([row.status, row.flagged, row.wouldBlock]);
          const group = summary.get(key) ?? {
            status: row.status,
            flagged: row.flagged,
            wouldBlock: row.wouldBlock,
            count: 0,
          };
          group.count++;
          summary.set(key, group);
          controller.enqueue(encoder.encode(JSON.stringify({ type: 'scan', ...row }) + '\n'));
        }
        if (rows.length < 500) {
          // Count emitted rows so concurrent reviews cannot make the summary disagree with its sample.
          controller.enqueue(
            encoder.encode(
              JSON.stringify({ type: 'summary', complete: true, groups: [...summary.values()] }) +
                '\n'
            )
          );
          controller.close();
        } else cursor = rows[rows.length - 1].id;
      } catch (error) {
        controller.error(error);
      }
    },
  });
  return new Response(stream, {
    headers: {
      'Content-Type': 'application/x-ndjson',
      'Content-Disposition': `attachment; filename="audio-shadow-${to
        .toISOString()
        .slice(0, 10)}.jsonl"`,
      'Cache-Control': 'private, no-store',
    },
  });
};
