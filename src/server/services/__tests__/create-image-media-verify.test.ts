import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { CreatedImageMediaVerdict } from '~/server/utils/created-image-media-probe';

const { probeMock } = vi.hoisted(() => ({
  probeMock: vi.fn<() => Promise<CreatedImageMediaVerdict>>(),
}));

vi.mock('~/server/utils/created-image-media-probe', () => ({
  probeCreatedImageMedia: probeMock,
}));

import { dbMock } from '~/__tests__/mocks/db.mock';
import { loggingMock } from '~/__tests__/mocks/logging.mock';
import { createImage } from '~/server/services/image.service';

/**
 * Distinct from every constant asserted below, so a mutant that logs a hardcoded key or the
 * wrong field cannot pass by coincidence.
 */
const KEY = '3f6c2b91-0d84-4a15-9e70-c2b8a4d15e33';
const USER_ID = 8113;
const POST_ID = 55207;
const CREATED_ID = 90210;

function givenVerdict(verdict: CreatedImageMediaVerdict) {
  probeMock.mockResolvedValue(verdict);
}

async function create(over: Record<string, unknown> = {}) {
  return createImage({
    url: KEY,
    type: 'image',
    userId: USER_ID,
    postId: POST_ID,
    skipIngestion: true,
    ...over,
  } as never);
}

/** The single `create-image-media-verify` line emitted by the call under test. */
function verifyLine() {
  const calls = loggingMock.logToAxiom.mock.calls.filter(
    (c: unknown[]) => (c[0] as { name?: string })?.name === 'create-image-media-verify'
  );
  expect(calls).toHaveLength(1);
  return calls[0][0] as Record<string, unknown>;
}

describe('createImage — media existence probe (observe-only)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    dbMock.dbWrite.image.create.mockResolvedValue({ id: CREATED_ID } as never);
  });

  it('probes the row url before writing the row', async () => {
    givenVerdict('present');

    await create();

    expect(probeMock).toHaveBeenCalledTimes(1);
    expect(probeMock).toHaveBeenCalledWith(KEY);
    // 🔴 The probe exists to answer BEFORE the row is committed — this is the whole reason
    // the check sits inside `createImage` rather than at a router. If it ran after, an
    // enforcing successor could not stop the write it is meant to stop.
    expect(probeMock.mock.invocationCallOrder[0]).toBeLessThan(
      dbMock.dbWrite.image.create.mock.invocationCallOrder[0]
    );
  });

  it.each<CreatedImageMediaVerdict>(['present', 'absent', 'unknown', 'not-applicable'])(
    'emits exactly one line carrying the %s verdict',
    async (verdict) => {
      givenVerdict(verdict);

      await create();

      // 🔴 One line on EVERY call, whatever the verdict — the `absent` count is only a rate
      // if the same log carries its own denominator, and `present` is the positive control
      // that separates "no defects" from "the probe never reached the store".
      expect(verifyLine()).toMatchObject({ verdict, userId: USER_ID, postId: POST_ID });
    }
  );

  it('carries the media key for a probed verdict', async () => {
    givenVerdict('absent');

    await create();

    // The only field that makes an `absent` verdict actionable: settling defect-vs-false-
    // verdict means HEADing this exact key by hand.
    expect(verifyLine().url).toBe(KEY);
  });

  it('omits the url for a not-applicable verdict', async () => {
    givenVerdict('not-applicable');

    await create({ url: 'some-file-the-caller-invented.png' });

    // 🔴 `not-applicable` is BY DEFINITION the arbitrary caller-supplied strings the
    // predicate rejected. Those are unbounded text nobody will ever look up, so they must
    // not be shipped to the log sink.
    expect(verifyLine().url).toBeNull();
  });

  it('still creates the row when the media is absent', async () => {
    givenVerdict('absent');

    // 🔴 OBSERVE-ONLY. An `absent` verdict must not reject: this ships to measure the rate,
    // and rejecting is a new user-facing failure mode that has to be sized first. If a
    // later change makes this throw, this test is the one that has to be updated
    // deliberately rather than the behaviour changing silently.
    await expect(create()).resolves.toEqual({ id: CREATED_ID });
    expect(dbMock.dbWrite.image.create).toHaveBeenCalledTimes(1);
  });

  it('still creates the row when the store could not be consulted', async () => {
    givenVerdict('unknown');

    await expect(create()).resolves.toEqual({ id: CREATED_ID });
    expect(dbMock.dbWrite.image.create).toHaveBeenCalledTimes(1);
  });

  it('logs a null postId rather than dropping the field when there is no post', async () => {
    givenVerdict('present');

    await create({ postId: undefined });

    const line = verifyLine();
    expect(line.postId).toBeNull();
    expect(line.userId).toBe(USER_ID);
  });
});
