import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
// Setup-order import: installs the shared ~/env/server / db / logging mocks before
// image.service evaluates env at module load.
import '~/__tests__/setup';

/**
 * `createImage` — the media a row points at must exist in the store.
 *
 * An `Image` row is written from client-supplied JSON: `url` (the media key), `width`,
 * `height`, `name`, `mimeType` and `sizeKB` all arrive over the wire and none of them
 * was checked against storage. Measured over a ~24 h window (~22,800 rows sampled), 10 rows
 * referenced media that was never stored — 7 where an upload had been attempted
 * seconds earlier and silently failed, 3 where no upload was ever attempted at all.
 * Both populations produce a complete, healthy-looking row whose media 404s forever.
 *
 * 🔴 Which is why this is an EXISTENCE check and not a "was this key ever signed"
 * registry lookup: a signature check sees only the 3.
 *
 * 🔴 And why the verdict is THREE-VALUED. `unknown` — the probe threw, timed out or
 * is unconfigured — is not evidence of loss, so it must fail OPEN. A boolean would
 * force that case to be counted as one of the other two and corrupt the very
 * measurement the observe-only rollout exists to take.
 *
 * These drive the REAL probe and the REAL `headObject` over a stubbed S3 `send`, so
 * the three verdicts are produced by AWS-SDK-shaped answers rather than by a fake
 * that could encode the same wrong shape as the code.
 */

import type * as S3Utils from '~/utils/s3-utils';

const { mockS3Send } = vi.hoisted(() => ({ mockS3Send: vi.fn() }));

// Keep the REAL module — the real `headObject` and the real not-found classifier must
// run — and override only the backend resolution, so the probe talks to `mockS3Send`.
vi.mock('~/utils/s3-utils', async (importOriginal) => {
  const actual = await importOriginal<typeof S3Utils>();
  return {
    ...actual,
    getImageUploadBackend: vi.fn(async () => ({
      s3: { send: mockS3Send },
      bucket: 'test-media-bucket',
      backend: 'backblaze' as const,
    })),
  };
});

import { createImage } from '~/server/services/image.service';
import { dbMock } from '~/__tests__/mocks/db.mock';
import { logToAxiom } from '~/server/logging/client';
import { env } from '~/env/server';

/** A bare media key — the shape an upload endpoint issues and stores as `Image.url`. */
const MEDIA_KEY = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
const CREATED_ID = 987_654;
const USER_ID = 4242;

/** The row `createImage` is asked to write. Literal, so nothing is derived from the code. */
const imageInput = {
  url: MEDIA_KEY,
  userId: USER_ID,
  name: 'pic.png',
  width: 640,
  height: 480,
  mimeType: 'image/png',
  sizeKB: 128,
  type: 'image' as const,
  // Isolates the gate from the ingestion pipeline, which is not what these assert.
  skipIngestion: true,
};

/** The bucket ANSWERS that the key is not there. */
function respondAbsent() {
  mockS3Send.mockRejectedValue(
    Object.assign(new Error('NotFound'), { name: 'NotFound', $metadata: { httpStatusCode: 404 } })
  );
}

/** The bucket cannot be consulted at all — a 403 from a rotated key, not a 404. */
function respondUnknown() {
  mockS3Send.mockRejectedValue(
    Object.assign(new Error('Forbidden'), {
      name: 'AccessDenied',
      $metadata: { httpStatusCode: 403 },
    })
  );
}

/** The bucket answers with a real object. */
function respondPresent() {
  mockS3Send.mockResolvedValue({ ContentLength: 131_072 });
}

const envRecord = env as unknown as Record<string, unknown>;
const setEnforce = (value: boolean) => {
  envRecord.CREATE_IMAGE_VERIFY_MEDIA_ENFORCE = value;
};

const verifyEvent = () =>
  vi
    .mocked(logToAxiom)
    .mock.calls.map((c) => c[0] as Record<string, unknown>)
    .find((c) => c?.name === 'create-image-media-verify');

beforeEach(() => {
  vi.mocked(logToAxiom).mockClear();
  mockS3Send.mockReset();
  // Cleared per test, not merely re-stubbed: the shared db mock is reset once per FILE,
  // so without this every `toHaveBeenCalledTimes(1)` is really asserting a running total.
  dbMock.dbWrite.image.create.mockReset();
  dbMock.dbWrite.image.create.mockResolvedValue({ id: CREATED_ID });
});

afterEach(() => {
  delete envRecord.CREATE_IMAGE_VERIFY_MEDIA_ENFORCE;
});

describe('createImage media verification — three verdicts x two gate states', () => {
  describe('verdict `absent` — the defect', () => {
    it('OBSERVE-ONLY (the shipped default): still creates the row, and logs', async () => {
      // 🔴 This is the case that protects the rollout, and the one most likely to be
      // written backwards. With the gate off nothing about the caller's outcome may
      // change — the row is written exactly as it is today. The only new thing is the
      // log line the `absent` rate will be read from.
      respondAbsent();
      setEnforce(false);

      const result = await createImage(imageInput);

      expect(result).toEqual({ id: CREATED_ID });
      expect(dbMock.dbWrite.image.create).toHaveBeenCalledTimes(1);
      expect(verifyEvent()).toMatchObject({
        name: 'create-image-media-verify',
        verdict: 'absent',
        enforcing: false,
        rejected: false,
      });
    });

    it('ENFORCING: rejects, and no row is written', async () => {
      respondAbsent();
      setEnforce(true);

      await expect(createImage(imageInput)).rejects.toThrow(
        'One of the files did not upload properly, please try again'
      );
      expect(dbMock.dbWrite.image.create).not.toHaveBeenCalled();
      expect(verifyEvent()).toMatchObject({ verdict: 'absent', enforcing: true, rejected: true });
    });
  });

  describe('verdict `unknown` — fail OPEN, in both gate states', () => {
    it('OBSERVE-ONLY: creates the row', async () => {
      respondUnknown();
      setEnforce(false);

      const result = await createImage(imageInput);

      expect(result).toEqual({ id: CREATED_ID });
      expect(dbMock.dbWrite.image.create).toHaveBeenCalledTimes(1);
      expect(verifyEvent()).toMatchObject({ verdict: 'unknown', rejected: false });
    });

    it('ENFORCING: still creates the row — inability to consult the bucket is not evidence of loss', async () => {
      respondUnknown();
      setEnforce(true);

      const result = await createImage(imageInput);

      expect(result).toEqual({ id: CREATED_ID });
      expect(dbMock.dbWrite.image.create).toHaveBeenCalledTimes(1);
      expect(verifyEvent()).toMatchObject({
        verdict: 'unknown',
        enforcing: true,
        rejected: false,
      });
    });
  });

  describe('verdict `present` — unchanged, in both gate states', () => {
    it.each([false, true])('creates the row with enforcing=%s', async (enforcing) => {
      respondPresent();
      setEnforce(enforcing);

      const result = await createImage(imageInput);

      expect(result).toEqual({ id: CREATED_ID });
      expect(dbMock.dbWrite.image.create).toHaveBeenCalledTimes(1);
      expect(verifyEvent()).toMatchObject({ verdict: 'present', rejected: false });
    });
  });
});

describe('createImage media verification — what must NOT be probed', () => {
  it('does not probe a full http(s) url, and never rejects it', async () => {
    // `addPostImageSchema` permits `z.url().or(z.string().uuid())`, and legacy avatar
    // rows hold a full external URL for a bucket we do not own — the same distinction
    // `deleteImageFromS3` documents. HEADing one of those against OUR bucket asks a
    // nonsensical question and would answer `absent` for a perfectly good row.
    respondAbsent();
    setEnforce(true);

    const result = await createImage({
      ...imageInput,
      url: 'https://cdn.example.com/legacy/avatar.png',
    });

    expect(result).toEqual({ id: CREATED_ID });
    expect(mockS3Send).not.toHaveBeenCalled();
    expect(verifyEvent()).toMatchObject({ verdict: 'not-applicable', rejected: false });
  });

  it('probes the media KEY, in the bucket the image-upload backend resolved', async () => {
    respondPresent();
    setEnforce(false);

    await createImage(imageInput);

    expect(mockS3Send).toHaveBeenCalledTimes(1);
    const command = mockS3Send.mock.calls[0][0] as { input: Record<string, unknown> };
    expect(command.input).toMatchObject({ Bucket: 'test-media-bucket', Key: MEDIA_KEY });
  });
});

describe('createImage media verification — the log is the measurement', () => {
  it('logs a verdict on EVERY call, not only the bad one — the rate needs a denominator', async () => {
    respondPresent();
    setEnforce(false);

    await createImage(imageInput);

    expect(verifyEvent()).toMatchObject({
      name: 'create-image-media-verify',
      verdict: 'present',
      enforcing: false,
      rejected: false,
      userId: USER_ID,
    });
  });

  it('a telemetry failure cannot change the outcome of the creation', async () => {
    // The log is fire-and-forget and contained. An awaited, uncontained logToAxiom
    // once turned ~5,300 successful uploads into 500s when the ingest host went
    // unreachable; nothing here may be able to repeat that.
    respondPresent();
    setEnforce(true);
    vi.mocked(logToAxiom).mockRejectedValueOnce(new Error('axiom unreachable'));

    const result = await createImage(imageInput);

    expect(result).toEqual({ id: CREATED_ID });
    expect(dbMock.dbWrite.image.create).toHaveBeenCalledTimes(1);
  });
});
