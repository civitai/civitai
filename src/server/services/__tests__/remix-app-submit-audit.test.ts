import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type * as FliptModule from '~/server/flipt/client';

/**
 * Condition A: a user app's fixed prompt text is audited as its author when a save changes the
 * code. Runs the REAL gate; only the external classifier, the flag and I/O are mocked, as in
 * pass-through-prompt-audit.refusal-code.test.ts, whose benign fixture the classifier flags here.
 */
const h = vi.hoisted(() => ({ flagged: false, inputs: [] as string[] }));
vi.mock('~/server/flipt/client', async (importOriginal) => ({
  ...(await importOriginal<typeof FliptModule>()),
  getFliptVariant: async () => null,
}));
vi.mock('~/server/redis/fail-open-log', () => ({ logSysRedisFailOpen: vi.fn() }));
vi.mock('~/server/clickhouse/client', () => ({ clickhouse: {} }));

import { dbMock } from '~/__tests__/mocks/db.mock';
import { setEnv } from '~/__tests__/mocks/env.mock';
import { redisMock } from '~/__tests__/mocks/redis.mock';
import { AppBlockPromptRefusalError } from '~/server/services/blocks/pass-through-prompt-audit';
import { REMIX_SOURCE_UNREADABLE } from '~/server/services/remix-app-audit.service';
import { submitUserRemixApp } from '~/server/services/remix-app-registry.service';

const FLAGGED = 'a quiet harbour at dusk';
const sourceWith = (prompt: string) => `export default defineRemixApp({
  async run(ctx) {
    const style = await ctx.ask({ kind: 'choice', prompt: 'Style?', options: [{ value: 'ink', label: 'Ink' }] });
    const out = await ctx.workflow({ kind: 'image', prompt: \`${prompt} in \${style}\`, images: [ctx.source], aspectRatio: 'source', quantity: 1 });
    return out.images;
  },
});`;
const submission = (source: string) => ({
  name: 'probe',
  title: 'Probe',
  icon: 'sparkles' as const,
  source,
  authorId: 7,
  isGreen: false,
});
const classified = () => h.inputs;
const saved = () =>
  dbMock.dbWrite.appBlock.create.mock.calls.length +
  dbMock.dbWrite.appBlock.updateMany.mock.calls.length;

/** The external classifier, at its HTTP boundary. */
const classifier = (async (_url: string, init: RequestInit) => {
  h.inputs.push(String(JSON.parse(String(init.body)).input));
  const score = h.flagged ? 0.99 : 0;
  return Response.json({
    results: [
      {
        flagged: h.flagged,
        categories: { violence: h.flagged },
        category_scores: { violence: score },
      },
    ],
  });
}) as unknown as typeof fetch;

beforeEach(() => {
  vi.clearAllMocks();
  h.flagged = false;
  h.inputs = [];
  setEnv({ EXTERNAL_MODERATION_ENDPOINT: 'http://classifier', EXTERNAL_MODERATION_TOKEN: 't' });
  vi.stubGlobal('fetch', classifier);
  redisMock.sysRedis.exists.mockResolvedValue(1);
  redisMock.sysRedis.lRange.mockResolvedValue([]);
  dbMock.dbWrite.appBlock.findUnique.mockResolvedValue(null);
  dbMock.dbWrite.appBlock.count.mockResolvedValue(0);
  dbMock.dbWrite.appBlock.findMany.mockResolvedValue([]);
  dbMock.dbWrite.appBlock.aggregate.mockResolvedValue({ _max: { featuredOrder: 0 } } as never);
  dbMock.dbRead.user.findUnique.mockResolvedValue({ isModerator: false } as never);
  dbMock.dbWrite.oauthClient.findUnique.mockResolvedValue({ id: 'remix' } as never);
});

afterEach(() => vi.unstubAllGlobals());

describe("an author's runner hold", () => {
  it('refuses the save when it lands while the audit runs', async () => {
    vi.stubGlobal('fetch', (async (url: string, init: RequestInit) => {
      dbMock.dbWrite.appBlock.findMany.mockResolvedValue([
        { id: 'other', blockId: 'remix-u7-other', manifest: { runnerHold: { at: '2026-11-21' } } },
      ] as never);
      return classifier(url, init);
    }) as unknown as typeof fetch);
    await expect(submitUserRemixApp(submission(sourceWith('a portrait')))).rejects.toMatchObject({
      code: 'PRECONDITION_FAILED',
    });
    expect(classified()).toHaveLength(1);
    expect(saved()).toBe(0);
  });
});

describe("a user app's fixed prompt text", () => {
  it('is audited as the author, its fixed pieces only, in one classifier call', async () => {
    await submitUserRemixApp(submission(sourceWith('a portrait')));
    expect(h.inputs).toHaveLength(1);
    const [call] = classified();
    expect(call).toContain('Style?');
    expect(call).toContain('a portrait in ');
    // The answer is the viewer's, audited with the run; and option labels are not prompts.
    expect(call).not.toContain('Ink');
    expect(saved()).toBe(1);
  });

  it('refuses the save when it blocks, and still refuses a resubmit of the same code', async () => {
    h.flagged = true;
    for (let attempt = 0; attempt < 2; attempt++)
      await expect(submitUserRemixApp(submission(sourceWith(FLAGGED)))).rejects.toBeInstanceOf(
        AppBlockPromptRefusalError
      );
    expect(h.inputs).toHaveLength(2);
    expect(saved()).toBe(0);
  });

  it('is not audited again by a save that leaves the code as stored', async () => {
    const source = sourceWith('a portrait');
    dbMock.dbWrite.appBlock.findUnique.mockResolvedValue({
      id: 'ab_rx_u7_probe_____________',
      blockId: 'remix-u7-probe',
      version: '1.0.0',
      status: 'remix_disabled',
      featuredOrder: 9,
      manifest: {
        kind: 'remix',
        name: 'Old title',
        version: '1.0.0',
        targets: [{ slotId: 'image.remix' }],
        remix: { icon: 'sparkles', engine: { safe: { ecosystem: 'x', versionId: 1 } }, source },
        author: { userId: 7 },
        review: 'submitted',
      },
    } as never);
    dbMock.dbWrite.appBlock.updateMany.mockResolvedValue({ count: 1 });
    await submitUserRemixApp({ ...submission('a portrait'), source });
    expect(h.inputs).toHaveLength(0);
    // POSITIVE CONTROL: a change to it is.
    await submitUserRemixApp({ ...submission('a portrait'), source: sourceWith('a landscape') });
    expect(h.inputs).toHaveLength(1);
  });

  it('refuses code that does not parse, before anything is classified or saved', async () => {
    await expect(
      submitUserRemixApp({ ...submission(''), source: 'export default defineRemixApp({' })
    ).rejects.toThrow(REMIX_SOURCE_UNREADABLE);
    expect(h.inputs).toHaveLength(0);
    expect(saved()).toBe(0);
  });
});
