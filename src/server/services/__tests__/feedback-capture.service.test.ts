import { PGlite } from '@electric-sql/pglite';
import { Prisma } from '@prisma/client';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type * as FliptClient from '~/server/flipt/client';
import type * as Ownership from '~/server/services/image-url-ownership';
import { FEEDBACK_CAPTURE_OWNER_ID } from '@civitai/shared/feedback-capture';
import { dbMock } from '~/__tests__/mocks/db.mock';
import { loggingMock } from '~/__tests__/mocks/logging.mock';

const { isFliptMock, keyIssuersMock, createImageMock } = vi.hoisted(() => ({
  isFliptMock: vi.fn(),
  keyIssuersMock: vi.fn(),
  createImageMock: vi.fn(),
}));
vi.mock('~/server/flipt/client', async (importOriginal) => ({
  ...(await importOriginal<typeof FliptClient>()),
  isFlipt: isFliptMock,
}));
vi.mock('~/server/services/image-url-ownership', async (importOriginal) => ({
  ...(await importOriginal<typeof Ownership>()),
  keyIssuers: keyIssuersMock,
}));
vi.mock('~/server/services/image.service', () => ({ createImage: createImageMock }));

const { captureFeedbackScreenshot } = await import('../feedback-capture.service');

const SHOT = '99999999-8888-4777-b666-555544443333';
const REPORTER = 42;
const issuers = (over: Partial<Awaited<ReturnType<typeof Ownership.keyIssuers>>> = {}) => ({
  tooMany: false,
  issuedToOthers: [],
  unrecorded: [],
  recordReadFailed: false,
  requestLogReadFailed: false,
  ...over,
});
const capture = (screenshotId: string | undefined = SHOT) =>
  captureFeedbackScreenshot({ feedbackId: 7, reporterId: REPORTER, screenshotId });
/** What was merged into the report's context. */
const recorded = () => {
  const call = dbMock.dbWrite.$executeRaw.mock.calls[0];
  return call ? JSON.parse(call[1] as string) : undefined;
};

beforeEach(() => {
  vi.clearAllMocks();
  isFliptMock.mockResolvedValue(true);
  keyIssuersMock.mockResolvedValue(issuers());
  createImageMock.mockResolvedValue({ id: 555 });
  dbMock.dbWrite.user.findUnique.mockResolvedValue({ id: FEEDBACK_CAPTURE_OWNER_ID } as never);
  dbMock.dbWrite.$executeRaw.mockResolvedValue(1);
  loggingMock.logToAxiom.mockResolvedValue(undefined);
});

describe('captureFeedbackScreenshot', () => {
  it('stores the reporter’s own capture as the capture account’s image, stamped server-side', async () => {
    expect(await capture()).toEqual({ screenshotImageId: 555 });
    expect(keyIssuersMock).toHaveBeenCalledWith({ urls: [SHOT], userId: REPORTER });
    expect(createImageMock).toHaveBeenCalledTimes(1);
    const args = createImageMock.mock.calls[0][0];
    expect(args).toMatchObject({
      url: SHOT,
      userId: FEEDBACK_CAPTURE_OWNER_ID,
      feedbackCapture: { feedbackId: 7, reporterId: REPORTER },
    });
    expect(args.postId).toBeUndefined();
    expect(args.skipIngestion).toBeUndefined();
    expect(recorded()).toEqual({ screenshotImageId: 555 });
  });

  it.each([
    ['issued to someone else', issuers({ issuedToOthers: [SHOT] }), 'not-owner'],
    ['with no issue record', issuers({ unrecorded: [SHOT] }), 'unverified'],
    ['over the key limit', issuers({ tooMany: true }), 'unverified'],
  ])('stores no image for a key %s', async (_, result, check) => {
    keyIssuersMock.mockResolvedValue(result);
    expect(await capture()).toEqual({ screenshotCheck: check });
    expect(createImageMock).not.toHaveBeenCalled();
    expect(recorded()).toEqual({ screenshotCheck: check });
  });

  it('stores no image when the capture account is missing', async () => {
    dbMock.dbWrite.user.findUnique.mockResolvedValue(null);
    expect(await capture()).toEqual({ screenshotCheck: 'unverified' });
    expect(createImageMock).not.toHaveBeenCalled();
  });

  it('records unverified when the image cannot be created, and does not throw', async () => {
    createImageMock.mockRejectedValue(new Error('refused'));
    expect(await capture()).toEqual({ screenshotCheck: 'unverified' });
    expect(recorded()).toEqual({ screenshotCheck: 'unverified' });
  });

  it('stores no image for a value that is not exactly one upload key', async () => {
    expect(await capture(`${SHOT}/${SHOT.replace('9999', '1111')}`)).toEqual({
      screenshotCheck: 'unverified',
    });
    expect(createImageMock).not.toHaveBeenCalled();
  });

  it('adds the outcome to the report, keeping its context, and touches no other report', async () => {
    const db = new PGlite();
    await db.exec(`
      CREATE TABLE "Feedback" (id int PRIMARY KEY, context jsonb);
      INSERT INTO "Feedback" VALUES
        (7, '{"screenshotId":"${SHOT}","path":"/models"}'), (8, '{"path":"/other"}'), (9, NULL);
    `);
    dbMock.dbWrite.$executeRaw.mockImplementation((async (
      strings: TemplateStringsArray,
      ...values: unknown[]
    ) => {
      const sql = Prisma.sql(strings, ...(values as never[]));
      return (await db.query(sql.text, sql.values)).affectedRows ?? 0;
    }) as never);

    await capture();
    await captureFeedbackScreenshot({ feedbackId: 9, reporterId: REPORTER, screenshotId: SHOT });

    const rows = (
      await db.query<{ id: number; context: unknown }>(
        `SELECT id, context FROM "Feedback" ORDER BY id`
      )
    ).rows;
    expect(rows).toEqual([
      { id: 7, context: { screenshotId: SHOT, path: '/models', screenshotImageId: 555 } },
      { id: 8, context: { path: '/other' } },
      { id: 9, context: { screenshotImageId: 555 } },
    ]);
    await db.close();
  });

  it('does not throw when the report cannot be updated', async () => {
    dbMock.dbWrite.$executeRaw.mockRejectedValue(new Error('db down'));
    expect(await capture()).toEqual({ screenshotImageId: 555 });
  });

  it('does nothing while the flag is off or there is no capture', async () => {
    isFliptMock.mockResolvedValue(false);
    expect(await capture()).toBeNull();
    isFliptMock.mockResolvedValue(true);
    expect(await captureFeedbackScreenshot({ feedbackId: 7, reporterId: REPORTER })).toBeNull();
    expect(keyIssuersMock).not.toHaveBeenCalled();
    expect(dbMock.dbWrite.$executeRaw).not.toHaveBeenCalled();
  });

  it('checks the flag for the reporter', async () => {
    await capture();
    expect(isFliptMock).toHaveBeenCalledWith('feedback-capture-scan', String(REPORTER));
  });
});
