import { createHash } from 'crypto';
import { EventEmitter } from 'events';
import type { NextApiRequest, NextApiResponse } from 'next';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type * as SessionModule from '~/server/auth/get-server-auth-session';
import type * as FlagsModule from '~/server/services/feature-flags.service';
import type * as EvidenceStore from '~/server/services/generator-evidence/evidence-store';
import type * as ModeratorService from '~/server/services/moderator.service';
import { dbMock } from '~/__tests__/mocks/db.mock';

/** The route that shows a moderator one preserved generator file. Ids and bytes are invented. */

const { session, flags, readEvidenceObject, trackModActivity } = vi.hoisted(() => ({
  session: { value: null as unknown },
  flags: { csamReports: true },
  readEvidenceObject: vi.fn(),
  trackModActivity: vi.fn(),
}));

vi.mock('~/server/auth/get-server-auth-session', async (importOriginal) => ({
  ...(await importOriginal<typeof SessionModule>()),
  getServerAuthSession: async () => session.value,
}));
vi.mock('~/server/services/feature-flags.service', async (importOriginal) => ({
  ...(await importOriginal<typeof FlagsModule>()),
  getFeatureFlags: () => flags,
}));
vi.mock('~/server/services/generator-evidence/evidence-store', async (importOriginal) => ({
  ...(await importOriginal<typeof EvidenceStore>()),
  readEvidenceObject,
}));
vi.mock('~/server/services/moderator.service', async (importOriginal) => ({
  ...(await importOriginal<typeof ModeratorService>()),
  trackModActivity,
}));

const { default: handler } = await import('~/pages/api/mod/csam/generator-evidence-file');

const BLOB = 'OUTPUT000000001.png';
const bytes = Buffer.from('preserved bytes');
const sha = createHash('sha256').update(bytes).digest('hex');

const report = (sha256 = sha) => ({
  details: {
    generatorEvidence: { version: 1 },
    generatedImages: [
      {
        jobId: 'wf',
        blobs: [
          {
            blobId: BLOB,
            role: 'output',
            status: 'preserved',
            evidenceKey: `generator-evidence/1/wf/${BLOB}`,
            sha256,
            contentType: 'image/png',
          },
        ],
      },
    ],
  },
});

async function get() {
  const req = Object.assign(new EventEmitter(), {
    method: 'GET',
    url: `/api/mod/csam/generator-evidence-file?reportId=3&blobId=${BLOB}`,
    query: { reportId: '3', blobId: BLOB },
    headers: {},
  }) as unknown as NextApiRequest;
  const res = Object.assign(new EventEmitter(), {
    statusCode: 200,
    headers: {} as Record<string, string>,
    setHeader: (name: string, value: string) => void (res.headers[name.toLowerCase()] = value),
    getHeader: (name: string) => res.headers[name.toLowerCase()],
    status(code: number) {
      res.statusCode = code;
      return res;
    },
    writeHead(code: number) {
      res.statusCode = code;
      return res;
    },
    json: () => res,
    end: () => res,
  });
  await handler(req, res as unknown as NextApiResponse);
  return res.statusCode;
}

beforeEach(() => {
  vi.clearAllMocks();
  flags.csamReports = true;
  session.value = { user: { id: 5, isModerator: true } };
  readEvidenceObject.mockResolvedValue({ bytes: new Uint8Array(bytes) });
  dbMock.dbRead.csamReport.findFirst.mockResolvedValue(report() as never);
});

describe('generator evidence file route', () => {
  it.each([
    ['no session', null],
    ['a member', { user: { id: 5, isModerator: false } }],
  ])('refuses %s before reading anything', async (_name, value) => {
    session.value = value;
    expect(await get()).toBe(401);
    expect(readEvidenceObject).not.toHaveBeenCalled();
  });

  it('refuses a moderator without CSAM reporting access with a 403', async () => {
    flags.csamReports = false;
    expect(await get()).toBe(403);
    expect(readEvidenceObject).not.toHaveBeenCalled();
  });

  it("serves the file to a moderator and records that moderator's view of it", async () => {
    expect(await get()).toBe(200);
    expect(trackModActivity).toHaveBeenCalledWith(5, {
      entityType: 'csamReport',
      entityId: 3,
      activity: `generatorEvidence:view:${BLOB}`,
    });
  });

  it('serves nothing and records no view when the copy no longer matches its sha256', async () => {
    dbMock.dbRead.csamReport.findFirst.mockResolvedValue(report('f'.repeat(64)) as never);
    expect(await get()).toBe(502);
    expect(trackModActivity).not.toHaveBeenCalled();
  });
});
