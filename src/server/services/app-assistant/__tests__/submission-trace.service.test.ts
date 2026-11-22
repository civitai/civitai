import type { StoredConversationMetadata } from '@civitai/components-chat/core';
import JSZip from 'jszip';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type * as FliptClient from '~/server/flipt/client';

/**
 * The submission trace builder over fake dependencies (`buildSubmissionTrace`): which chats it
 * reads (the SUBMITTER's links only), what it freezes and where, what one failing chat does to the
 * rest, and that nothing it meets throws. Plus the flag gate of `recordSubmissionTrace`.
 */

const m = vi.hoisted(() => ({ tracingOn: { value: true } }));
vi.mock('~/server/flipt/client', async (importOriginal) => ({
  ...(await importOriginal<typeof FliptClient>()),
  isFlipt: vi.fn(async (flag: string) => flag === 'app-assistant-tracing' && m.tracingOn.value),
}));

const {
  buildSubmissionTrace,
  bundleSignalFiles,
  deleteAssistantTracesOfAccount,
  MAX_TRACED_SESSIONS,
  recordSubmissionTrace,
  transcriptKey,
  TRANSCRIPT_PREFIX,
} = await import('~/server/services/app-assistant/submission-trace.service');
type Deps = Parameters<typeof buildSubmissionTrace>[1];

// Pairwise-distinct ids, chats, Buzz and paths.
const REQUEST = 'pubreq_trace_test_01';
const SLUG = 'trace-under-test';
const SUBMITTER = 7301;

function chat(conversationId: string, buzz: number, path: string): StoredConversationMetadata {
  return {
    v: 2,
    app: 'chat-cvt',
    conversationId,
    title: conversationId,
    titleSource: 'first-message',
    createdAt: '2026-11-20T00:00:00.000Z',
    updatedAt: '2026-11-20T00:00:00.000Z',
    turns: [
      {
        seq: 1,
        createdAt: '2026-11-20T00:00:00.000Z',
        user: { content: 'build it', attachments: [] },
        assistant: {
          status: 'done',
          buzz,
          messages: [
            {
              role: 'assistant',
              content: [
                {
                  type: 'tool-call',
                  toolCallId: `w-${conversationId}`,
                  toolName: 'sandbox__write_file',
                  input: { path },
                },
              ],
            },
          ],
        },
      },
    ],
  } as unknown as StoredConversationMetadata;
}

const CHATS: Record<string, StoredConversationMetadata> = {
  'conv-one': chat('conv-one', 4, 'src/one.ts'),
  'conv-two': chat('conv-two', 9, 'src/two.ts'),
};

function deps(overrides: Partial<Deps> = {}) {
  const stored = new Map<string, string>();
  const written: Parameters<Deps['write']>[0][] = [];
  const linksCalls: [string, number][] = [];
  const d: Deps = {
    links: async (slug, userId) => {
      linksCalls.push([slug, userId]);
      return ['conv-one', 'conv-two'];
    },
    reader: async () => ({ read: async (id) => CHATS[id] ?? null }),
    store: async (key, body) => void stored.set(key, body),
    files: async () => new Map([['src/index.css', ':root { --civitai-color-primary: red; }']]),
    write: async (row) => void written.push(row),
    defaultModel: 'default-model-q',
    now: () => new Date('2026-11-21T12:00:00.000Z'),
    ...overrides,
  };
  return { d, stored, written, linksCalls };
}

const input = {
  publishRequestId: REQUEST,
  slug: SLUG,
  submittedByUserId: SUBMITTER,
  bundleBuffer: Buffer.from(''),
};

beforeEach(() => {
  m.tracingOn.value = true;
});

describe('buildSubmissionTrace', () => {
  it('reads the submitter’s own links, freezes each chat at its own key, and signals what it froze', async () => {
    const { d, stored, written, linksCalls } = deps();
    const result = await buildSubmissionTrace(input, d);
    expect(linksCalls).toEqual([[SLUG, SUBMITTER]]);
    expect([...stored.keys()]).toEqual([
      transcriptKey(REQUEST, 'conv-one'),
      transcriptKey(REQUEST, 'conv-two'),
    ]);
    const frozen = JSON.parse(stored.get(transcriptKey(REQUEST, 'conv-one'))!);
    expect(frozen).toEqual({
      v: 1,
      publishRequestId: REQUEST,
      slug: SLUG,
      userId: SUBMITTER,
      conversationId: 'conv-one',
      capturedAt: '2026-11-21T12:00:00.000Z',
      metadata: JSON.parse(JSON.stringify(CHATS['conv-one'])),
    });
    expect(written).toHaveLength(1);
    expect(written[0]).toMatchObject({
      publishRequestId: REQUEST,
      slug: SLUG,
      userId: SUBMITTER,
      conversationIds: ['conv-one', 'conv-two'],
      signalsVersion: 1,
      snapshotError: null,
    });
    expect(
      written[0]!.snapshots.map(({ conversationId, turns, error }) => [
        conversationId,
        turns,
        error,
      ])
    ).toEqual([
      ['conv-one', 1, undefined],
      ['conv-two', 1, undefined],
    ]);
    expect(result!.signals).toMatchObject({
      sessionCount: 2,
      turnCount: 2,
      buzzTotal: 13,
      models: ['default-model-q'],
      editedFiles: ['src/one.ts', 'src/two.ts'],
      themeCustomized: true,
    });
  });

  it('keys a chat by a hash of its id under the transcript prefix: a page-chosen id never shapes the path', () => {
    const key = transcriptKey(REQUEST, '../../bundles/x');
    expect(key.startsWith(`${TRANSCRIPT_PREFIX}/${REQUEST}/`)).toBe(true);
    expect(key).toMatch(/^[a-z-]+\/pubreq_trace_test_01\/[0-9a-f]{32}\.json$/);
  });

  it('one chat that cannot be read, or is gone, or cannot be stored is recorded; the rest are frozen', async () => {
    const { d, written } = deps({
      links: async () => ['conv-one', 'conv-gone', 'conv-broken', 'conv-two'],
      reader: async () => ({
        read: async (id) => {
          if (id === 'conv-broken') throw new Error('orchestration 500');
          return CHATS[id] ?? null;
        },
      }),
      store: async (key) => {
        if (key === transcriptKey(REQUEST, 'conv-two')) throw new Error('store down');
      },
    });
    const result = await buildSubmissionTrace(input, d);
    expect(written[0]!.snapshots.map((s) => [s.conversationId, s.error ?? 'frozen'])).toEqual([
      ['conv-one', 'frozen'],
      ['conv-gone', 'not-found'],
      ['conv-broken', 'read-failed'],
      ['conv-two', 'store-failed'],
    ]);
    expect(written[0]!.snapshotError).toBe('3 of 4 chats not frozen');
    // Only the frozen chat feeds the signals.
    expect(result!.signals).toMatchObject({ sessionCount: 1, buzzTotal: 4 });
  });

  it('a submitter who turned App Assistant off: no chat read, each recorded as consent, theme still judged', async () => {
    const { d, stored, written } = deps({ reader: async () => ({ refused: 'consent' }) });
    const result = await buildSubmissionTrace(input, d);
    expect(stored.size).toBe(0);
    expect(written[0]!.snapshots).toEqual([
      { conversationId: 'conv-one', error: 'consent' },
      { conversationId: 'conv-two', error: 'consent' },
    ]);
    expect(written[0]!.snapshotError).toBe('transcripts: consent');
    expect(result!.signals).toMatchObject({ sessionCount: 0, themeCustomized: true });
  });

  it('no links (a CLI submit): no chat read, a trace row with the bundle’s signals only', async () => {
    let readerAsked = false;
    const { d, written } = deps({
      links: async () => [],
      reader: async () => {
        readerAsked = true;
        return { refused: 'unavailable' };
      },
    });
    await buildSubmissionTrace(input, d);
    expect(readerAsked).toBe(false);
    expect(written[0]).toMatchObject({ conversationIds: [], snapshots: [], snapshotError: null });
  });

  it('traces at most MAX_TRACED_SESSIONS chats', async () => {
    const many = Array.from({ length: MAX_TRACED_SESSIONS + 3 }, (_, i) => `conv-${i}`);
    const { d, written } = deps({ links: async () => many });
    await buildSubmissionTrace(input, d);
    expect(written[0]!.conversationIds).toEqual(many.slice(0, MAX_TRACED_SESSIONS));
  });

  it('chats named by the caller (the backfill) replace the link rows', async () => {
    const { d, written, linksCalls } = deps();
    await buildSubmissionTrace({ ...input, conversationIds: ['conv-two'] }, d);
    expect(linksCalls).toEqual([]);
    expect(written[0]!.conversationIds).toEqual(['conv-two']);
  });

  it('nothing it meets throws: failing links, reader, bundle and row write', async () => {
    const { d } = deps({
      links: async () => {
        throw new Error('db down');
      },
      files: async () => {
        throw new Error('zip');
      },
      write: async () => {
        throw new Error('relation "app_publish_request_traces" does not exist');
      },
    });
    await expect(buildSubmissionTrace(input, d)).resolves.toBeNull();
    const { d: d2, written } = deps({
      reader: async () => {
        throw new Error('mint down');
      },
    });
    await buildSubmissionTrace(input, d2);
    expect(written[0]!.snapshotError).toBe('transcripts: unavailable');
  });
});

describe('recordSubmissionTrace', () => {
  it('with the flag off does nothing at all', async () => {
    m.tracingOn.value = false;
    // With the flag on this would reach the real dependencies; off, it returns before them.
    await expect(recordSubmissionTrace(input)).resolves.toBeUndefined();
    const { dbMock } = await import('~/__tests__/mocks/db.mock');
    expect(dbMock.dbRead.appAssistantSessionLink.findMany).not.toHaveBeenCalled();
    expect(dbMock.dbWrite.appPublishRequestTrace.create).not.toHaveBeenCalled();
  });

  it('with the flag on and every dependency failing still resolves', async () => {
    const { dbMock } = await import('~/__tests__/mocks/db.mock');
    dbMock.dbRead.appAssistantSessionLink.findMany.mockRejectedValueOnce(new Error('db down'));
    dbMock.dbWrite.appPublishRequestTrace.create.mockRejectedValueOnce(new Error('no table'));
    await expect(recordSubmissionTrace(input)).resolves.toBeUndefined();
    expect(dbMock.dbWrite.appPublishRequestTrace.create).toHaveBeenCalledTimes(1);
  });
});

describe('bundleSignalFiles', () => {
  it('reads the source files and package.json, and nothing else', async () => {
    const zip = new JSZip();
    zip.file('src/app.css', '.a{}');
    zip.file('package.json', '{}');
    zip.file('assets/icon.png', Buffer.from([1, 2, 3]));
    zip.file('README.md', '# hi');
    const files = await bundleSignalFiles(await zip.generateAsync({ type: 'nodebuffer' }));
    expect([...files.keys()].sort()).toEqual(['package.json', 'src/app.css']);
  });
});

describe('deleteAssistantTracesOfAccount (retention: deleted with the account)', () => {
  const P = (request: string) => `${TRANSCRIPT_PREFIX}/${request}/`;
  function world(failKey?: string) {
    const objects = new Set([
      `${P('pubreq_one')}a.json`,
      `${P('pubreq_one')}stray.json`, // in the store, but no longer named by the row
      `${P('pubreq_two')}b.json`,
      `${P('pubreq_other_user')}c.json`,
    ]);
    const rowsDeleted: number[] = [];
    const deps = {
      traces: async () => [
        {
          publishRequestId: 'pubreq_one',
          snapshots: [{ conversationId: 'c1', key: `${P('pubreq_one')}a.json` }],
        },
        {
          publishRequestId: 'pubreq_two',
          // A key outside this request's prefix is never deleted through it.
          snapshots: [
            { conversationId: 'c2', key: `${P('pubreq_other_user')}c.json` },
            { conversationId: 'c3', error: 'not-found' },
          ],
        },
      ],
      listKeys: async (prefix: string) => [...objects].filter((key) => key.startsWith(prefix)),
      deleteObject: async (key: string) => {
        if (key === failKey) throw new Error('store refused');
        objects.delete(key);
      },
      deleteRows: async (userId: number) => {
        rowsDeleted.push(userId);
        return { traces: 2, links: 5 };
      },
    };
    return { objects, rowsDeleted, deps };
  }

  it('deletes every frozen transcript under the user’s requests, then their trace and link rows', async () => {
    const { objects, rowsDeleted, deps } = world();
    expect(await deleteAssistantTracesOfAccount(SUBMITTER, deps)).toEqual({
      objects: 3,
      failedObjects: 0,
      traces: 2,
      links: 5,
    });
    expect([...objects]).toEqual([`${P('pubreq_other_user')}c.json`]);
    expect(rowsDeleted).toEqual([SUBMITTER]);
  });

  it('an object it cannot delete keeps the rows, so they still name what is left', async () => {
    const { objects, rowsDeleted, deps } = world(`${P('pubreq_two')}b.json`);
    expect(await deleteAssistantTracesOfAccount(SUBMITTER, deps)).toEqual({
      objects: 2,
      failedObjects: 1,
      traces: 0,
      links: 0,
    });
    expect(objects.has(`${P('pubreq_two')}b.json`)).toBe(true);
    expect(rowsDeleted).toEqual([]);
  });

  it('a listing that fails still deletes the keys the rows name, and keeps the rows', async () => {
    const { objects, rowsDeleted, deps } = world();
    deps.listKeys = async () => {
      throw new Error('list refused');
    };
    const outcome = await deleteAssistantTracesOfAccount(SUBMITTER, deps);
    expect(outcome).toMatchObject({ objects: 1, failedObjects: 2 });
    expect(objects.has(`${P('pubreq_one')}a.json`)).toBe(false);
    expect(rowsDeleted).toEqual([]);
  });

  it('never throws: a trace read that fails is a failure counted, nothing deleted', async () => {
    const { rowsDeleted, deps } = world();
    deps.traces = async () => {
      throw new Error('db down');
    };
    await expect(deleteAssistantTracesOfAccount(SUBMITTER, deps)).resolves.toMatchObject({
      failedObjects: 1,
    });
    expect(rowsDeleted).toEqual([]);
  });
});
