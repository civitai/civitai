import { beforeEach, describe, expect, it, vi } from 'vitest';
import type * as ImageUploadModule from '~/server/services/orchestrator/imageUpload';
import { dbMock } from '~/__tests__/mocks/db.mock';
import { redisMock } from '~/__tests__/mocks/redis.mock';

const { mockImageUpload } = vi.hoisted(() => ({ mockImageUpload: vi.fn() }));
vi.mock('~/server/services/orchestrator/imageUpload', async (importOriginal) => ({
  ...(await importOriginal<typeof ImageUploadModule>()),
  imageUpload: (...a: unknown[]) => mockImageUpload(...a),
}));

import { TRPCError } from '@trpc/server';
import {
  BLOCK_TRAINING_IMPORT_BUDGET_MS,
  BLOCK_TRAINING_IMPORT_TIMEOUT_MS,
  admitTrainingImage,
  assertBlockTrainingDatasetStillEligible,
  loadBlockTrainingDataset,
  prepareBlockTrainingDataset,
  trainingBlobAirFromImport,
  type BlockTrainingActor,
} from '../block-training-dataset.service';
import { BLOCK_TRAINING_DATASET_MAX_ITEMS } from '~/server/schema/blocks/workflow.schema';
import { BLOCK_TRAINING_CAPTION_MAX_CHARS } from '~/server/schema/blocks/training-dataset.schema';
import { MAX_AUDIT_PROMPT_LENGTH, auditPromptEnriched } from '~/utils/metadata/audit';

/**
 * The `kind:'training'` DATASET primitive: admission per image, server-derived
 * count, caption moderation BEFORE any import, and a handle bound to the
 * subject/app/install that prepared it.
 */

// PG (1) | PG13 (2) — a SFW ceiling. 4 (R) is above it.
const SFW_CEILING = 1 | 2;
const ACTOR: BlockTrainingActor = {
  userId: 42,
  appBlockId: 'apb_1',
  blockInstanceId: 'page_apb_1',
  browsingLevel: SFW_CEILING,
  allowMatureContent: false,
};

function row(over: Record<string, unknown> = {}) {
  return {
    id: 1,
    url: 'img-key-1',
    type: 'image',
    nsfwLevel: 1,
    ingestion: 'Scanned',
    needsReview: null,
    poi: false,
    minor: false,
    tosViolation: false,
    acceptableMinor: false,
    blockedFor: null,
    ...over,
  };
}

const BLOB_URL = (k: string) => `https://orch.example/v2/consumer/blobs/${k}.jpeg?sig=abc`;

beforeEach(() => {
  mockImageUpload.mockReset();
  dbMock.dbRead.$queryRaw.mockReset();
  redisMock.sysRedis.set.mockReset();
  redisMock.sysRedis.get.mockReset();
  mockImageUpload.mockImplementation(async ({ sourceImage }: { sourceImage: string }) => ({
    blob: { id: 'b', available: true, url: BLOB_URL(sourceImage.split('/').at(-3) ?? 'x') },
  }));
});

describe('admitTrainingImage — one rule per refusal', () => {
  it('admits a scanned, unflagged image of the viewer within the ceiling', () => {
    expect(admitTrainingImage(row(), SFW_CEILING)).toBeNull();
  });

  it.each([
    ['not found / not the viewer’s', null, 'unavailable'],
    ['a video row', row({ type: 'video' }), 'unsupported-media'],
    ['marked as a minor', row({ minor: true }), 'not-eligible'],
    ['marked as a real person', row({ poi: true }), 'not-eligible'],
    ['a ToS violation', row({ tosViolation: true }), 'not-eligible'],
    ['hard-blocked', row({ blockedFor: 'moderated' }), 'not-eligible'],
    ['flagged for review', row({ needsReview: 'poi' }), 'not-eligible'],
    ['scan-blocked', row({ ingestion: 'Blocked' }), 'not-eligible'],
    ['still scanning', row({ ingestion: 'Pending', nsfwLevel: 0 }), 'pending-scan'],
    ['rated above the token ceiling', row({ nsfwLevel: 4 }), 'not-eligible'],
  ])('refuses %s', (_label, r, reason) => {
    expect(admitTrainingImage(r as never, SFW_CEILING)).toBe(reason);
  });

  it('the same R image is admitted under a ceiling that includes R (control)', () => {
    expect(admitTrainingImage(row({ nsfwLevel: 4 }) as never, SFW_CEILING | 4)).toBeNull();
  });
});

describe('trainingBlobAirFromImport', () => {
  it('keeps the consumer-blob url without its signature', () => {
    expect(trainingBlobAirFromImport({ available: true, url: BLOB_URL('k1') })).toBe(
      'https://orch.example/v2/consumer/blobs/k1.jpeg'
    );
  });

  it.each([
    ['unavailable', { available: false, url: BLOB_URL('k') }],
    ['blocked', { available: true, url: BLOB_URL('k'), blockedReason: 'policy' }],
    ['no url', { available: true, url: null }],
    ['a url of another shape', { available: true, url: 'https://cdn.example/k.jpeg' }],
  ])('refuses %s', (_l, blob) => {
    expect(trainingBlobAirFromImport(blob)).toBeNull();
  });
});

describe('prepareBlockTrainingDataset', () => {
  const audit = vi.fn(async () => undefined);
  beforeEach(() => audit.mockReset());

  it('stores only admitted, imported images; the count is server-derived', async () => {
    dbMock.dbRead.$queryRaw.mockResolvedValue([
      row({ id: 1, url: 'k1' }),
      row({ id: 2, url: 'k2', minor: true }),
      row({ id: 3, url: 'k3' }),
    ]);
    const out = await prepareBlockTrainingDataset({
      actor: ACTOR,
      items: [
        { imageId: 1, caption: ' a cat ' },
        { imageId: 2, caption: 'b' },
        { imageId: 3, caption: 'c' },
        { imageId: 9, caption: 'not mine' },
      ],
      token: 'tok',
      auditCaptions: audit,
    });
    expect(out.count).toBe(2);
    expect(out.datasetId).toMatch(/^tds_[a-f0-9]{32}$/);
    expect(out.rejected).toEqual([
      { imageId: 2, reason: 'not-eligible' },
      { imageId: 9, reason: 'unavailable' },
    ]);

    // Captions are moderated once, over the ADMITTED set only, before any import.
    expect(audit).toHaveBeenCalledTimes(1);
    expect(audit).toHaveBeenCalledWith('a cat\nc');
    expect(audit.mock.invocationCallOrder[0]).toBeLessThan(
      mockImageUpload.mock.invocationCallOrder[0]
    );

    // Imported under the VIEWER's token with the token's maturity clamp.
    expect(mockImageUpload).toHaveBeenCalledTimes(2);
    for (const call of mockImageUpload.mock.calls) {
      expect(call[0]).toMatchObject({ token: 'tok', allowMatureContent: false });
    }

    const [key, value, opts] = redisMock.sysRedis.set.mock.calls[0];
    expect(key).toBe(`system:blocks:training-dataset:${out.datasetId}`);
    expect(opts).toEqual({ EX: 24 * 60 * 60 });
    const stored = JSON.parse(value as string);
    expect(stored).toMatchObject({
      userId: 42,
      appBlockId: 'apb_1',
      blockInstanceId: 'page_apb_1',
      count: 2,
    });
    expect(stored.items.map((i: { imageId: number }) => i.imageId)).toEqual([1, 3]);
    expect(stored.items[0].caption).toBe('a cat');
    expect(stored.items[0].air).toBe('https://orch.example/v2/consumer/blobs/k1.jpeg');
  });

  it('scopes the image query to the viewer (provenance is the viewer’s own images)', async () => {
    dbMock.dbRead.$queryRaw.mockResolvedValue([row({ id: 1 })]);
    await prepareBlockTrainingDataset({
      actor: ACTOR,
      items: [{ imageId: 1, caption: '' }],
      token: 'tok',
      auditCaptions: audit,
    });
    const [strings, ...values] = dbMock.dbRead.$queryRaw.mock.calls[0] as [
      TemplateStringsArray,
      ...unknown[]
    ];
    expect(strings.join('?')).toMatch(/i\."userId" = \?/);
    expect(values).toContain(42);
  });

  it('an image the orchestrator does not accept is reported, not stored', async () => {
    dbMock.dbRead.$queryRaw.mockResolvedValue([
      row({ id: 1, url: 'k1' }),
      row({ id: 2, url: 'k2' }),
    ]);
    mockImageUpload.mockImplementationOnce(async () => {
      throw new Error('mature content not allowed');
    });
    const out = await prepareBlockTrainingDataset({
      actor: ACTOR,
      items: [
        { imageId: 1, caption: '' },
        { imageId: 2, caption: '' },
      ],
      token: 'tok',
      auditCaptions: audit,
    });
    expect(out.count).toBe(1);
    expect(out.rejected).toEqual([{ imageId: 1, reason: 'import-failed' }]);
  });

  it('a refused caption set stops the request before any import', async () => {
    dbMock.dbRead.$queryRaw.mockResolvedValue([row({ id: 1 })]);
    audit.mockRejectedValueOnce(new Error('prompt refused'));
    await expect(
      prepareBlockTrainingDataset({
        actor: ACTOR,
        items: [{ imageId: 1, caption: 'bad' }],
        token: 'tok',
        auditCaptions: audit,
      })
    ).rejects.toThrow('prompt refused');
    expect(mockImageUpload).not.toHaveBeenCalled();
    expect(redisMock.sysRedis.set).not.toHaveBeenCalled();
  });

  it('nothing admitted is a refusal, and nothing is stored', async () => {
    dbMock.dbRead.$queryRaw.mockResolvedValue([row({ id: 1, poi: true })]);
    await expect(
      prepareBlockTrainingDataset({
        actor: ACTOR,
        items: [{ imageId: 1, caption: '' }],
        token: 'tok',
        auditCaptions: audit,
      })
    ).rejects.toThrow('none of the requested images can be used for training');
    expect(mockImageUpload).not.toHaveBeenCalled();
    expect(redisMock.sysRedis.set).not.toHaveBeenCalled();
  });

  it('duplicate ids collapse to one item (first caption wins)', async () => {
    dbMock.dbRead.$queryRaw.mockResolvedValue([row({ id: 1, url: 'k1' })]);
    const out = await prepareBlockTrainingDataset({
      actor: ACTOR,
      items: [
        { imageId: 1, caption: 'first' },
        { imageId: 1, caption: 'second' },
      ],
      token: 'tok',
      auditCaptions: audit,
    });
    expect(out.count).toBe(1);
    expect(mockImageUpload).toHaveBeenCalledTimes(1);
    expect(audit).toHaveBeenCalledWith('first');
  });

  it('refuses more than the per-dataset maximum', async () => {
    const items = Array.from({ length: BLOCK_TRAINING_DATASET_MAX_ITEMS + 1 }, (_, i) => ({
      imageId: i + 1,
      caption: '',
    }));
    await expect(
      prepareBlockTrainingDataset({ actor: ACTOR, items, token: 'tok', auditCaptions: audit })
    ).rejects.toThrow(`at most ${BLOCK_TRAINING_DATASET_MAX_ITEMS}`);
    expect(dbMock.dbRead.$queryRaw).not.toHaveBeenCalled();
  });
});

describe('prepareBlockTrainingDataset — caption audit stays under the audit length cap', () => {
  // The REAL regex audit, not a mock: it hard-refuses any input over
  // MAX_AUDIT_PROMPT_LENGTH, so a single join of a schema-valid caption set was refused
  // for its size alone.
  const calls: string[] = [];
  const realAudit = vi.fn(async (text: string) => {
    calls.push(text);
    const { success, blockedFor } = auditPromptEnriched(text, undefined, false);
    if (!success) throw new Error(`refused: ${blockedFor.join(', ')}`);
  });
  beforeEach(() => {
    calls.length = 0;
    realAudit.mockClear();
  });

  const FILLER = 'landscape photo of a mountain lake at sunrise, pine trees, mist, ';
  // Ends in '.', never whitespace: the service trims captions, so a trailing space would
  // silently shorten the fixture.
  const caption = (len: number) =>
    FILLER.repeat(Math.ceil(len / FILLER.length)).slice(0, len - 1) + '.';

  async function prepare(captions: string[]) {
    const rows = captions.map((_, i) => row({ id: i + 1, url: `k${i + 1}` }));
    dbMock.dbRead.$queryRaw.mockResolvedValue(rows);
    return prepareBlockTrainingDataset({
      actor: ACTOR,
      items: captions.map((c, i) => ({ imageId: i + 1, caption: c })),
      token: 'tok',
      auditCaptions: realAudit,
    });
  }

  it.each([
    [
      '50 × 1000 (schema maximum)',
      BLOCK_TRAINING_DATASET_MAX_ITEMS,
      BLOCK_TRAINING_CAPTION_MAX_CHARS,
    ],
    ['50 × 400', BLOCK_TRAINING_DATASET_MAX_ITEMS, 400],
  ])('a schema-valid %s caption set is not refused for its size', async (_l, n, len) => {
    // The fixture really is over the cap when joined, or this test proves nothing.
    expect(n * len + (n - 1)).toBeGreaterThan(MAX_AUDIT_PROMPT_LENGTH);
    const out = await prepare(Array.from({ length: n }, () => caption(len)));
    expect(out.count).toBe(n);
    expect(calls.length).toBeGreaterThan(1);
    for (const c of calls) expect(c.length).toBeLessThanOrEqual(MAX_AUDIT_PROMPT_LENGTH);
    // Every caption is audited exactly once, whole and in order.
    expect(calls.join('\n')).toBe(Array.from({ length: n }, () => caption(len)).join('\n'));
  });

  it('a banned caption late in a full set is still caught, before any import (positive control)', async () => {
    const captions = Array.from({ length: BLOCK_TRAINING_DATASET_MAX_ITEMS }, () =>
      caption(BLOCK_TRAINING_CAPTION_MAX_CHARS)
    );
    captions[48] = '13 year old, revealing outfit';
    await expect(prepare(captions)).rejects.toThrow(/^refused: (?!Prompt exceeds)/);
    expect(mockImageUpload).not.toHaveBeenCalled();
    expect(redisMock.sysRedis.set).not.toHaveBeenCalled();
  });

  it('packs a batch to EXACTLY the cap, and splits one character past it', async () => {
    // 19 × 1000 + 18 separators = 19018; a 981-char 20th caption (+1 separator) lands
    // the batch on exactly MAX_AUDIT_PROMPT_LENGTH.
    const exact = MAX_AUDIT_PROMPT_LENGTH - 19 * 1000 - 19;
    expect(exact).toBe(981);
    const head = Array.from({ length: 19 }, () => caption(1000));
    await prepare([...head, caption(exact), caption(10)]);
    expect(calls.map((c) => c.length)).toEqual([MAX_AUDIT_PROMPT_LENGTH, 10]);

    calls.length = 0;
    await prepare([...head, caption(exact + 1), caption(10)]);
    expect(calls.map((c) => c.length)).toEqual([19 * 1000 + 18, exact + 1 + 1 + 10]);
  });

  it('never splits a caption: one over the cap is audited alone and refused', async () => {
    await expect(prepare(['a cat', caption(MAX_AUDIT_PROMPT_LENGTH + 5)])).rejects.toThrow(
      'Prompt exceeds the maximum allowed length'
    );
    expect(calls.map((c) => c.length)).toEqual([5, MAX_AUDIT_PROMPT_LENGTH + 5]);
    expect(mockImageUpload).not.toHaveBeenCalled();
  });
});

describe('loadBlockTrainingDataset — the handle is bound to subject, app and install', () => {
  const ID = `tds_${'a'.repeat(32)}`;
  const stored = {
    v: 1,
    datasetId: ID,
    userId: 42,
    appBlockId: 'apb_1',
    blockInstanceId: 'page_apb_1',
    items: [
      { imageId: 1, air: 'a', caption: '', thumbnailUrl: 't' },
      { imageId: 2, air: 'b', caption: '', thumbnailUrl: 't' },
    ],
    // A tampered/stale count is never trusted — `items.length` wins.
    count: 999,
    createdAt: 'x',
  };
  const binding = { userId: 42, appBlockId: 'apb_1', blockInstanceId: 'page_apb_1' };

  it('loads for the binding that prepared it, with the count re-derived', async () => {
    redisMock.sysRedis.get.mockResolvedValue(JSON.stringify(stored));
    const ds = await loadBlockTrainingDataset(ID, binding);
    expect(ds?.count).toBe(2);
  });

  it.each([
    ['another viewer', { ...binding, userId: 7 }],
    ['another app', { ...binding, appBlockId: 'apb_2' }],
    ['another install', { ...binding, blockInstanceId: 'page_apb_9' }],
  ])('is null for %s', async (_l, other) => {
    redisMock.sysRedis.get.mockResolvedValue(JSON.stringify(stored));
    expect(await loadBlockTrainingDataset(ID, other)).toBeNull();
  });

  it('is null for an expired handle and never reads Redis for a malformed one', async () => {
    redisMock.sysRedis.get.mockResolvedValue(null);
    expect(await loadBlockTrainingDataset(ID, binding)).toBeNull();
    redisMock.sysRedis.get.mockClear();
    expect(await loadBlockTrainingDataset('tds_../../x', binding)).toBeNull();
    expect(redisMock.sysRedis.get).not.toHaveBeenCalled();
  });
});

describe('import failures are classified, and the timeout is per image', () => {
  const audit = vi.fn(async () => undefined);

  it('an unavailable orchestrator is a RETRYABLE reason, a refusal is not', async () => {
    dbMock.dbRead.$queryRaw.mockResolvedValue([
      row({ id: 1, url: 'k1' }),
      row({ id: 2, url: 'k2' }),
      row({ id: 3, url: 'k3' }),
    ]);
    mockImageUpload
      .mockImplementationOnce(async () => {
        throw new TRPCError({ code: 'SERVICE_UNAVAILABLE', message: 'down' });
      })
      .mockImplementationOnce(async () => {
        throw new TRPCError({ code: 'BAD_REQUEST', message: 'mature content not allowed' });
      });
    const out = await prepareBlockTrainingDataset({
      actor: ACTOR,
      items: [
        { imageId: 1, caption: '' },
        { imageId: 2, caption: '' },
        { imageId: 3, caption: '' },
      ],
      token: 'tok',
      auditCaptions: audit,
    });
    expect(out.count).toBe(1);
    expect(out.rejected).toEqual([
      { imageId: 1, reason: 'import-unavailable' },
      { imageId: 2, reason: 'import-failed' },
    ]);
  });

  it('a stuck import times out as import-unavailable without holding the others', async () => {
    vi.useFakeTimers();
    try {
      dbMock.dbRead.$queryRaw.mockResolvedValue([
        row({ id: 1, url: 'k1' }),
        row({ id: 2, url: 'k2' }),
      ]);
      mockImageUpload.mockImplementationOnce(() => new Promise(() => undefined));
      const pending = prepareBlockTrainingDataset({
        actor: ACTOR,
        items: [
          { imageId: 1, caption: '' },
          { imageId: 2, caption: '' },
        ],
        token: 'tok',
        auditCaptions: audit,
      });
      let settled = false;
      void pending.then(() => (settled = true)).catch(() => (settled = true));
      await vi.advanceTimersByTimeAsync(BLOCK_TRAINING_IMPORT_TIMEOUT_MS + 1);
      // Settled by the deadline itself — not by the runner's timeout.
      expect(settled).toBe(true);
      const out = await pending;
      expect(out.count).toBe(1);
      expect(out.rejected).toEqual([{ imageId: 1, reason: 'import-unavailable' }]);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('the whole-request import budget', () => {
  it('images not STARTED before the budget runs out are never imported', async () => {
    vi.useFakeTimers();
    try {
      // 14 hanging imports, 4 at a time, each cut at the per-image deadline: waves
      // start at 0, 20, 40 s (12 imports); at 60 s the budget is spent, so the last
      // two are reported without ever being sent.
      expect(BLOCK_TRAINING_IMPORT_BUDGET_MS / BLOCK_TRAINING_IMPORT_TIMEOUT_MS).toBe(3);
      const rows = Array.from({ length: 14 }, (_, i) => row({ id: i + 1, url: `k${i + 1}` }));
      dbMock.dbRead.$queryRaw.mockResolvedValue(rows);
      mockImageUpload.mockImplementation(() => new Promise(() => undefined));
      const pending = prepareBlockTrainingDataset({
        actor: ACTOR,
        items: rows.map((r) => ({ imageId: r.id, caption: '' })),
        token: 'tok',
        auditCaptions: vi.fn(async () => undefined),
      });
      let message: string | null = null;
      void pending.then(
        () => (message = 'resolved'),
        (e: Error) => (message = e.message)
      );
      await vi.advanceTimersByTimeAsync(BLOCK_TRAINING_IMPORT_BUDGET_MS * 2);
      // Settled by the deadlines themselves — not by the runner's timeout.
      expect(message).not.toBeNull();
      expect(message).toContain('none of the requested images could be prepared');
      expect(mockImageUpload).toHaveBeenCalledTimes(12);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('assertBlockTrainingDatasetStillEligible — re-admission on the primary', () => {
  const dataset = {
    v: 1 as const,
    datasetId: `tds_${'a'.repeat(32)}`,
    userId: 42,
    appBlockId: 'apb_1',
    blockInstanceId: 'page_apb_1',
    items: [
      { imageId: 1, air: 'a', caption: '', thumbnailUrl: 't' },
      { imageId: 2, air: 'b', caption: '', thumbnailUrl: 't' },
    ],
    count: 2,
    createdAt: 'x',
  };
  beforeEach(() => dbMock.dbWrite.$queryRaw.mockReset());

  it('passes while every image still passes, reading the PRIMARY scoped to the owner', async () => {
    dbMock.dbWrite.$queryRaw.mockResolvedValue([row({ id: 1 }), row({ id: 2 })]);
    await expect(
      assertBlockTrainingDatasetStillEligible(dataset, SFW_CEILING)
    ).resolves.toBeUndefined();
    const [, , owner] = dbMock.dbWrite.$queryRaw.mock.calls[0] as unknown[];
    expect(owner).toBe(42);
    expect(dbMock.dbRead.$queryRaw).not.toHaveBeenCalled();
  });

  it.each([
    ['an image flagged since preparation', [row({ id: 1 }), row({ id: 2, tosViolation: true })]],
    ['an image deleted since preparation', [row({ id: 1 })]],
  ])('refuses %s', async (_l, rows) => {
    dbMock.dbWrite.$queryRaw.mockResolvedValue(rows);
    await expect(assertBlockTrainingDatasetStillEligible(dataset, SFW_CEILING)).rejects.toThrow(
      'can no longer be used for training'
    );
  });
});
