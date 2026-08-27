import fs from 'fs';
import path from 'path';
import { describe, expect, it } from 'vitest';

/**
 * Every notification processor that can emit for a `CommentV2` must carry the per-thread mute
 * filter. This is not a style rule: the comment family dedupes by `commentDedupeKey` and runs in
 * priority batches, so a processor that omits `notThreadMuted` doesn't merely leak its own
 * notification — it CLAIMS the dedupe key and replaces the higher-priority one that was correctly
 * suppressed. Muting a thread would then change which notification you get rather than silencing it.
 *
 * Legacy `Comment` (model-page discussion) processors are out of scope by design: those rows have no
 * `Thread`, so there is nothing to mute. That is why this keys on the table the query reads rather
 * than on the processor name.
 *
 * `new-mention` is the one deliberate exception — see the test naming it below.
 *
 * If you are adding a comment type and this failed: add
 * `AND ${notThreadMuted(<recipient>, 't.id')}` to its query, beside `notBlockedBetween`.
 */

/**
 * Muting a thread silences "somebody in a thread you're in responded"; it does NOT silence being
 * named. Justin's call, 2026-08-27: "there are people that would want to be notified if they still
 * got mentions directly ... direct mentions would be excluded from this."
 *
 * Safe against the dedupe batching rather than in spite of it: `Mention` is priority 1, so when a
 * muted thread does mention you the mention lands FIRST and claims the dedupe key, and the reply /
 * thread-response notifications the mute did suppress cannot re-emerge behind it.
 */
const MUTE_EXEMPT = new Set(['new-mention']);

const FILES = [
  'src/server/notifications/comment.notifications.ts',
  'src/server/notifications/mention.notifications.ts',
];

type Processor = { file: string; name: string; body: string };

function readProcessors(): Processor[] {
  const out: Processor[] = [];
  for (const file of FILES) {
    const source = fs.readFileSync(path.join(process.cwd(), file), 'utf-8').split('\n');
    let name: string | null = null;
    let body: string[] = [];
    for (const line of source) {
      const match = line.match(/^ {2}'([a-z0-9-]+)': \{/);
      if (match) {
        if (name) out.push({ file, name, body: body.join('\n') });
        name = match[1];
        body = [];
      } else if (name) body.push(line);
    }
    if (name) out.push({ file, name, body: body.join('\n') });
  }
  return out;
}

describe('comment notification processors', () => {
  const processors = readProcessors();

  // Guards the extractor itself: a regex that stopped matching would make every assertion below
  // vacuous, and an empty forEach reports as a pass.
  it('finds the comment processors it is meant to check', () => {
    expect(processors.length).toBeGreaterThanOrEqual(17);
    expect(processors.map((p) => p.name)).toContain('new-image-comment');
    expect(processors.map((p) => p.name)).toContain('new-mention');
    expect(processors.filter((p) => p.body.includes('FROM "CommentV2"')).length).toBeGreaterThan(
      10
    );
  });

  it.each(
    readProcessors().filter((p) => p.body.includes('FROM "CommentV2"') && !MUTE_EXEMPT.has(p.name))
  )('$name applies the per-thread mute filter', ({ name, body }) => {
    expect(
      body.includes('notThreadMuted('),
      `${name} reads CommentV2 but never calls notThreadMuted — a muted thread would still notify through it, and its dedupe claim would suppress the notification that WAS filtered`
    ).toBe(true);
  });

  // Named for the decision: if you are here because a mute "leaks" a mention, that is the intended
  // behaviour and this is where it was decided. Adding notThreadMuted to new-mention reverses a
  // product call, so it fails here rather than passing quietly.
  it('leaves direct mentions muteable ONLY through the global new-mention setting', () => {
    const mention = processors.find((p) => p.name === 'new-mention');
    expect(mention).toBeDefined();
    expect(mention?.body.includes('FROM "CommentV2"')).toBe(true);
    expect(mention?.body.includes('notThreadMuted(')).toBe(false);
  });

  it('leaves the legacy Comment-only processors alone', () => {
    const legacy = processors.filter(
      (p) => p.body.includes('FROM "Comment"') && !p.body.includes('FROM "CommentV2"')
    );
    expect(legacy.map((p) => p.name)).toEqual([
      'new-comment',
      'new-comment-response',
      'new-comment-nested',
    ]);
  });
});
