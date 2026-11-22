import { describe, expect, it } from 'vitest';
import {
  chatChoseApp,
  conversationsChoosing,
  BACKFILL_PAGE,
  runTraceBackfill,
  toolResultsOfChat,
  type BackfillDeps,
  type BackfillRequest,
} from '~/server/services/app-assistant/trace-backfill';

/** A saved chat whose one reply made `calls` ([toolName, output as saved]). */
function chat(conversationId: string, calls: Array<[string, unknown]>) {
  return {
    conversationId,
    turns: [
      {
        seq: 1,
        assistant: {
          messages: [
            {
              role: 'assistant',
              content: calls.map(([toolName], i) => ({
                type: 'tool-call',
                toolCallId: `${conversationId}-${i}`,
                toolName,
                input: {},
              })),
            },
            {
              role: 'tool',
              content: calls.map(([toolName, output], i) => ({
                type: 'tool-result',
                toolCallId: `${conversationId}-${i}`,
                toolName,
                output,
              })),
            },
          ],
        },
      },
    ],
  };
}
const json = (value: unknown) => ({ type: 'json', value });

describe('the backfill matcher', () => {
  it('a chat whose create_app made the app, or whose use_open_app / wake_app opened it, chose it', () => {
    expect(chatChoseApp(chat('a', [['create_app', json({ app: 'slug-one' })]]), 'slug-one')).toBe(
      true
    );
    expect(chatChoseApp(chat('b', [['use_open_app', json({ app: 'slug-one' })]]), 'slug-one')).toBe(
      true
    );
    expect(chatChoseApp(chat('c', [['wake_app', json({ app: 'slug-one' })]]), 'slug-one')).toBe(
      true
    );
  });

  it('a call that failed, a create_app that found the app existing, or another app does not count', () => {
    expect(
      chatChoseApp(
        chat('d', [['use_open_app', json({ app: 'slug-one', error: 'no' })]]),
        'slug-one'
      )
    ).toBe(false);
    expect(
      chatChoseApp(
        chat('e', [['create_app', json({ app: 'slug-one', existed: true })]]),
        'slug-one'
      )
    ).toBe(false);
    expect(
      chatChoseApp(
        chat('f', [['use_open_app', { type: 'error-text', value: 'slug-one' }]]),
        'slug-one'
      )
    ).toBe(false);
    expect(chatChoseApp(chat('g', [['create_app', json({ app: 'slug-two' })]]), 'slug-one')).toBe(
      false
    );
    expect(chatChoseApp(chat('h', [['read_docs', json({ app: 'slug-one' })]]), 'slug-one')).toBe(
      false
    );
  });

  it('a call with no result (cut off) is not read', () => {
    const cut = chat('i', [['use_open_app', json({ app: 'slug-one' })]]);
    cut.turns[0]!.assistant.messages.pop();
    expect(toolResultsOfChat(cut)).toEqual([]);
  });

  it('lists the matching chats in order, once each', () => {
    const chats = [
      chat('m1', [['create_app', json({ app: 'slug-one' })]]),
      chat('m2', [['create_app', json({ app: 'slug-two' })]]),
      chat('m3', [
        ['use_open_app', json({ app: 'slug-two' })],
        ['use_open_app', json({ app: 'slug-one' })],
      ]),
      chat('m1', [['create_app', json({ app: 'slug-one' })]]),
    ];
    expect(conversationsChoosing(chats, 'slug-one')).toEqual(['m1', 'm3']);
  });
});

describe('runTraceBackfill', () => {
  // Newest first: r5 … r1. User 7301's chats cannot be read; 7402's chose each request's slug.
  const ALL: BackfillRequest[] = [5, 4, 3, 2, 1].map((n) => ({
    id: `r${n}`,
    slug: `slug-${n}`,
    submittedByUserId: n % 2 ? 7301 : 7402,
    bundleKey: '',
  }));
  function world(failOn?: string) {
    const lines: string[] = [];
    const traced: string[] = [];
    const pages: Array<string | undefined> = [];
    const deps: BackfillDeps = {
      page: async ({ after, take }) => {
        pages.push(after);
        const from = after ? ALL.findIndex((r) => r.id === after) + 1 : 0;
        return ALL.slice(from, from + take);
      },
      chatsOf: async (userId) =>
        userId === 7301
          ? 'consent'
          : ALL.map((r) => chat(`conv-${r.id}`, [['create_app', json({ app: r.slug })]])),
      trace: async (request, ids) => {
        if (request.id === failOn) throw new Error('bundle store down');
        traced.push(`${request.id}:${ids.join(',')}`);
        return { snapshotError: null };
      },
      log: (line) => void lines.push(line),
    };
    return { lines, traced, pages, deps };
  }

  it('moves past what it skipped: a second run resumes after the first run’s last request', async () => {
    const first = world();
    const one = await runTraceBackfill({ apply: true, limit: 2, includeEmpty: false }, first.deps);
    expect(one).toMatchObject({ seen: 2, traced: 1, skipped: 1, next: 'r4' });
    expect(first.traced).toEqual(['r4:conv-r4']);
    expect(first.lines.at(-1)).toBe('next: --before r4');

    const second = world();
    const two = await runTraceBackfill(
      { apply: true, limit: 2, includeEmpty: false, before: 'r4' },
      second.deps
    );
    expect(second.pages[0]).toBe('r4');
    // r5 (skipped last time) is not looked at again; the run reaches r3 and r2.
    expect(two).toMatchObject({ seen: 2, traced: 1, skipped: 1 });
    expect(second.traced).toEqual(['r2:conv-r2']);
  });

  it('one request that throws is logged and the run goes on', async () => {
    const { traced, lines, deps } = world('r4');
    const summary = await runTraceBackfill({ apply: true, limit: 5, includeEmpty: false }, deps);
    expect(summary).toMatchObject({ seen: 5, traced: 1, failed: 1, skipped: 3, next: 'r1' });
    expect(traced).toEqual(['r2:conv-r2']);
    expect(lines.some((l) => /^r4 .*FAILED \(bundle store down\), going on$/.test(l))).toBe(true);
  });

  it('pages past the first page with its cursor: 120 requests are each looked at once', async () => {
    // More than one page (BACKFILL_PAGE): numbers that no page size divides evenly.
    const many: BackfillRequest[] = Array.from({ length: 120 }, (_, i) => ({
      id: `m${String(120 - i).padStart(3, '0')}`,
      slug: `s${i}`,
      submittedByUserId: 7402,
      bundleKey: '',
    }));
    const seen: string[] = [];
    const afters: Array<string | undefined> = [];
    const summary = await runTraceBackfill(
      { apply: false, limit: 500, includeEmpty: false },
      {
        page: async ({ after, take }) => {
          afters.push(after);
          const from = after ? many.findIndex((r) => r.id === after) + 1 : 0;
          return many.slice(from, from + take);
        },
        chatsOf: async () => [],
        trace: async () => null,
        log: (line) => {
          const id = /^(m\d+) /.exec(line)?.[1];
          if (id) seen.push(id);
        },
      }
    );
    expect(summary).toMatchObject({ seen: 120, next: null });
    expect(new Set(seen).size).toBe(120);
    expect(afters).toEqual([
      undefined,
      many[BACKFILL_PAGE - 1]!.id,
      many[2 * BACKFILL_PAGE - 1]!.id,
    ]);
  });

  it('a dry run writes nothing, and says where it stopped', async () => {
    const { traced, lines, deps } = world();
    expect(
      await runTraceBackfill({ apply: false, limit: 3, includeEmpty: true }, deps)
    ).toMatchObject({
      seen: 3,
      traced: 0,
      next: 'r3',
    });
    expect(traced).toEqual([]);
    expect(lines.at(-2)).toMatch(/^DRY RUN: seen 3/);
  });
});
