import { beforeEach, describe, expect, it, vi } from 'vitest';
import { dbMock } from '~/__tests__/mocks/db.mock';
import { NsfwLevel } from '~/server/common/enums';

const recompute = vi.hoisted(() => vi.fn(async () => undefined));
vi.mock('~/server/services/text-scan/rated-entities', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  recomputeRatedEntityNsfwLevel: recompute,
}));

const { applyPostTextTextScan } = await import('~/server/services/text-scan/actions/image-caption');
const { postTextTextScanSubject } = await import(
  '~/server/services/text-scan/profiles/post-text.profile'
);
const { textScanTextHash } = await import('~/server/services/text-scan/prompt');

const w = dbMock.dbWrite;
const ID = 31;
const POST = 7;
const TEXT = { userId: 3, content: '<p>The robot walks home.</p>', nsfwLevel: 0 };
const HASH = textScanTextHash(postTextTextScanSubject(TEXT));

type Verdict = { nsfw?: number; poi?: boolean; minor?: boolean; csam?: boolean };
const args = (v: Verdict, textHash = HASH) => ({
  entityId: ID,
  workflowId: 'wf-1',
  textHash,
  subject: { fields: [], declared: {} },
  outcome: {
    triggeredLabels: [],
    nsfwLevel: v.nsfw ?? null,
    ...(v.nsfw !== undefined && {
      nsfw: { detectedLevel: v.nsfw, declaredLevel: 0, raised: v.nsfw > 1, reason: 'r' },
    }),
    ...(v.poi !== undefined && {
      poi: { detected: v.poi, declared: false, newlyDetected: v.poi, names: [], reason: 'r' },
    }),
    ...(v.minor !== undefined && {
      minor: { detected: v.minor, declared: false, newlyDetected: v.minor, reason: 'r' },
    }),
    ...(v.csam !== undefined && { csam: { detected: v.csam, reason: 'r' } }),
  },
});

const writes = () => w.postText.updateMany.mock.calls.map(([call]) => call);
const dataWith = (key: string) => writes().filter((call) => key in (call?.data ?? {}));

describe('applyPostTextTextScan', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    w.postText.findUnique.mockImplementation((async ({ select }: { select: object }) =>
      'postId' in select ? { postId: POST } : TEXT) as never);
    w.postText.updateMany.mockResolvedValue({ count: 1 } as never);
  });

  it('stores an nsfw verdict below R as R, and a PG verdict as PG', async () => {
    await applyPostTextTextScan(args({ nsfw: NsfwLevel.PG13, poi: false, minor: false }) as never);
    expect(dataWith('nsfwLevel')[0]?.data).toEqual({ nsfwLevel: NsfwLevel.R });

    vi.clearAllMocks();
    await applyPostTextTextScan(args({ nsfw: NsfwLevel.PG, poi: false, minor: false }) as never);
    expect(dataWith('nsfwLevel')[0]?.data).toEqual({ nsfwLevel: NsfwLevel.PG });
  });

  it('keeps an XXX verdict at XXX and recomputes the post', async () => {
    await applyPostTextTextScan(args({ nsfw: NsfwLevel.XXX, poi: false, minor: false }) as never);
    expect(dataWith('nsfwLevel')[0]?.data).toEqual({ nsfwLevel: NsfwLevel.XXX });
    expect(recompute).toHaveBeenCalledWith('Post', POST);
  });

  it('refuses a real person, and a later clean verdict of the current text lets it back', async () => {
    await applyPostTextTextScan(args({ nsfw: NsfwLevel.PG, poi: true, minor: false }) as never);
    expect(dataWith('refused')).toEqual([
      { where: { id: ID, refused: false }, data: { refused: true } },
    ]);

    vi.clearAllMocks();
    await applyPostTextTextScan(args({ nsfw: NsfwLevel.PG, poi: false, minor: false }) as never);
    expect(dataWith('refused')).toEqual([
      { where: { id: ID, content: TEXT.content, refused: true }, data: { refused: false } },
    ]);
  });

  it('holds on a csam verdict, and no clean verdict ever clears the hold', async () => {
    await applyPostTextTextScan(
      args({ nsfw: NsfwLevel.PG, poi: false, minor: false, csam: true }) as never
    );
    expect(dataWith('csamHeld')).toEqual([{ where: { id: ID }, data: { csamHeld: true } }]);

    vi.clearAllMocks();
    await applyPostTextTextScan(
      args({ nsfw: NsfwLevel.PG, poi: false, minor: false, csam: false }) as never
    );
    expect(dataWith('csamHeld')).toEqual([]);
    // The control: the clean verdict did write, just not the hold.
    expect(dataWith('nsfwLevel')).toHaveLength(1);
  });
});
