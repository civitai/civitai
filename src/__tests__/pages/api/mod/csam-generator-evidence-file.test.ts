import { createHash } from 'crypto';
import { EventEmitter } from 'events';
import { Writable } from 'stream';
import type { NextApiRequest, NextApiResponse } from 'next';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type * as SessionModule from '~/server/auth/get-server-auth-session';
import type * as FlagsModule from '~/server/services/feature-flags.service';
import type * as EvidenceStore from '~/server/services/generator-evidence/evidence-store';
import type * as ModeratorService from '~/server/services/moderator.service';
import { dbMock } from '~/__tests__/mocks/db.mock';

/** The route that shows a moderator one preserved generator file. Ids and bytes are invented. */

const { session, flags, streamEvidenceObject, trackModActivity } = vi.hoisted(() => ({
  session: { value: null as unknown },
  flags: { csamReports: true },
  streamEvidenceObject: vi.fn(),
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
  streamEvidenceObject,
}));
vi.mock('~/server/services/moderator.service', async (importOriginal) => ({
  ...(await importOriginal<typeof ModeratorService>()),
  trackModActivity,
}));

const { default: handler } = await import('~/pages/api/mod/csam/generator-evidence-file');

const BLOB = 'OUTPUT000000001.png';
const bytes = Buffer.from('preserved bytes');
const sha = createHash('sha256').update(bytes).digest('hex');

const report = (sha256 = sha, blob: Record<string, unknown> = {}) => ({
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
            ...blob,
          },
        ],
      },
    ],
  },
});

let served: { headers: Record<string, string>; body?: Buffer };

async function get(blobId = BLOB) {
  const req = Object.assign(new EventEmitter(), {
    method: 'GET',
    url: `/api/mod/csam/generator-evidence-file?reportId=3&blobId=${blobId}`,
    query: { reportId: '3', blobId },
    headers: {},
  }) as unknown as NextApiRequest;
  const chunks: Buffer[] = [];
  const sink = new Writable({
    write(chunk, _encoding, done) {
      chunks.push(Buffer.from(chunk));
      done();
    },
  });
  sink.on('finish', () => (served.body = Buffer.concat(chunks)));
  const res = Object.assign(sink, {
    statusCode: 200,
    headers: {} as Record<string, string>,
    setHeader: (name: string, value: string) => void (res.headers[name.toLowerCase()] = value),
    getHeader: (name: string) => res.headers[name.toLowerCase()],
    status(code: number) {
      res.statusCode = code;
      return res;
    },
    writeHead(code: number, headers: Record<string, string> = {}) {
      res.statusCode = code;
      for (const [name, value] of Object.entries(headers)) res.headers[name.toLowerCase()] = value;
      return res;
    },
    json: () => res,
  });
  // As Next's API resolver does: next-axiom's wrapper calls the `end` it replaced unbound.
  const end = sink.end;
  Object.assign(sink, { end: (...args: Parameters<typeof end>) => end.apply(sink, args) });
  served = { headers: res.headers };
  await handler(req, res as unknown as NextApiResponse);
  return res.statusCode;
}

beforeEach(() => {
  vi.clearAllMocks();
  flags.csamReports = true;
  session.value = { user: { id: 5, isModerator: true } };
  streamEvidenceObject.mockResolvedValue({ chunks: [new Uint8Array(bytes)] });
  // Only a GeneratedImage report is a generator evidence report, whatever its details hold.
  dbMock.dbRead.csamReport.findFirst.mockImplementation((async (args: {
    where: { id?: number; type?: string };
  }) => (args.where.id === 3 && args.where.type === 'GeneratedImage' ? report() : null)) as never);
});

describe('generator evidence file route', () => {
  it.each([
    ['no session', null],
    ['a member', { user: { id: 5, isModerator: false } }],
  ])('refuses %s before reading anything', async (_name, value) => {
    session.value = value;
    expect(await get()).toBe(401);
    expect(streamEvidenceObject).not.toHaveBeenCalled();
  });

  it('refuses a moderator without CSAM reporting access with a 403', async () => {
    flags.csamReports = false;
    expect(await get()).toBe(403);
    expect(streamEvidenceObject).not.toHaveBeenCalled();
  });

  it("serves the file to a moderator and records that moderator's view of it", async () => {
    expect(await get()).toBe(200);
    expect(served.body?.equals(bytes)).toBe(true);
    expect(served.headers).toMatchObject({
      'content-type': 'image/png',
      'content-length': String(bytes.length),
      'x-content-type-options': 'nosniff',
      'content-security-policy': "sandbox; default-src 'none'",
      'cache-control': 'private, no-store',
    });
    expect(trackModActivity).toHaveBeenCalledWith(5, {
      entityType: 'csamReport',
      entityId: 3,
      activity: `generatorEvidence:view:${BLOB}`,
    });
  });

  it('serves nothing and records no view when the copy no longer matches its sha256', async () => {
    dbMock.dbRead.csamReport.findFirst.mockResolvedValue(report('f'.repeat(64)) as never);
    expect(await get()).toBe(502);
    expect(served.body).toBeUndefined();
    expect(trackModActivity).not.toHaveBeenCalled();
  });

  it('stops reading a file with no recorded size past the viewing limit, and serves nothing', async () => {
    const chunk = new Uint8Array(1024 * 1024);
    let pulled = 0;
    async function* long() {
      for (let i = 0; i < 80; i++) {
        pulled++;
        yield chunk;
      }
    }
    streamEvidenceObject.mockResolvedValue({ chunks: long() });
    dbMock.dbRead.csamReport.findFirst.mockResolvedValue(
      report(sha, { bytes: undefined }) as never
    );

    expect(await get()).toBe(413);
    expect(pulled).toBe(65);
    expect(served.body).toBeUndefined();
    expect(trackModActivity).not.toHaveBeenCalled();
  });

  it.each([
    ['an excluded file', report(sha, { status: 'excluded' }), BLOB, 404],
    ['a file that was not preserved', report(sha, { status: 'blocked-unreadable' }), BLOB, 404],
    ['a blob the report does not name', report(), 'OTHER0000000001.png', 404],
    ['a file that is not media', report(sha, { contentType: 'text/html' }), BLOB, 415],
    ['a file over the viewing limit', report(sha, { bytes: 64 * 1024 * 1024 + 1 }), BLOB, 413],
  ])('serves nothing and records no view for %s', async (_name, row, blobId, status) => {
    dbMock.dbRead.csamReport.findFirst.mockResolvedValue(row as never);
    expect(await get(blobId)).toBe(status);
    expect(streamEvidenceObject).not.toHaveBeenCalled();
    expect(served.body).toBeUndefined();
    expect(trackModActivity).not.toHaveBeenCalled();
  });
});
