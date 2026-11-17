import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { dbMock } from '~/__tests__/mocks/db.mock';
import { CSAM_SEND_CLAIM_EXPIRY_SECONDS } from '~/server/services/csam-send-claim';
import { sweepStaleSendDirs } from '~/server/services/csam.service-new';

/** The send job's start-of-run sweep of scratch directories. Ids are invented. */

type Row = { id: number; sendClaimId: string | null; sendClaimedAt: Date | null };
type Where = {
  id: { in: number[] };
  sendClaimId: { not: null };
  sendClaimedAt: { gte: Date };
};

const LIVE = '11111111-1111-4111-8111-111111111111';
const EXPIRED = '22222222-2222-4222-8222-222222222222';
const RELEASED = '33333333-3333-4333-8333-333333333333';
const REPLACED = '44444444-4444-4444-8444-444444444444';

let root: string;
let rows: Row[];
const ago = (seconds: number) => new Date(Date.now() - seconds * 1000);
const dir = (scratch: string, name: string) => path.join(root, scratch, name);
const make = (scratch: string, name: string) => {
  fs.mkdirSync(path.join(dir(scratch, name), 'entries'), { recursive: true });
  fs.writeFileSync(path.join(dir(scratch, name), 'entries', 'entry-0'), 'x');
};

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'csam-sweep-'));
  rows = [
    { id: 1, sendClaimId: LIVE, sendClaimedAt: ago(60) },
    { id: 2, sendClaimId: EXPIRED, sendClaimedAt: ago(CSAM_SEND_CLAIM_EXPIRY_SECONDS + 60) },
    { id: 3, sendClaimId: null, sendClaimedAt: null },
    { id: 4, sendClaimId: LIVE, sendClaimedAt: ago(60) },
  ];
  dbMock.dbWrite.csamReport.findMany
    .mockReset()
    .mockImplementation((async ({ where }: { where: Where }) =>
      rows
        .filter(
          (r) =>
            where.id.in.includes(r.id) &&
            r.sendClaimId !== null &&
            r.sendClaimedAt !== null &&
            r.sendClaimedAt >= where.sendClaimedAt.gte
        )
        .map(({ id, sendClaimId }) => ({ id, sendClaimId }))) as never);
});

afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

describe('sweepStaleSendDirs', () => {
  it('removes every send directory no live claim owns, and keeps the live one', async () => {
    make('generated-send', `1-${LIVE}`);
    make('generated-send', `2-${EXPIRED}`);
    make('training-data', `3-${RELEASED}`);
    make('external-send', `4-${REPLACED}`);

    const removed = await sweepStaleSendDirs(root);

    expect(fs.existsSync(dir('generated-send', `1-${LIVE}`))).toBe(true);
    expect(fs.existsSync(dir('generated-send', `2-${EXPIRED}`))).toBe(false);
    expect(fs.existsSync(dir('training-data', `3-${RELEASED}`))).toBe(false);
    expect(fs.existsSync(dir('external-send', `4-${REPLACED}`))).toBe(false);
    expect(removed).toHaveLength(3);
  });

  it('leaves directories that are not a send run, such as an archive named by report id alone', async () => {
    make('training-data', '2');
    make('generated-send', 'notes');

    expect(await sweepStaleSendDirs(root)).toEqual([]);
    expect(fs.existsSync(dir('training-data', '2'))).toBe(true);
    expect(fs.existsSync(dir('generated-send', 'notes'))).toBe(true);
  });

  it('reads nothing when there is no scratch directory', async () => {
    expect(await sweepStaleSendDirs(root)).toEqual([]);
    expect(dbMock.dbWrite.csamReport.findMany).not.toHaveBeenCalled();
  });
});
