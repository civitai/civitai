import { beforeEach, describe, expect, it, vi } from 'vitest';
import { dbMock } from '~/__tests__/mocks/db.mock';
import { envMock } from '~/__tests__/mocks/env.mock';
import { loggingMock } from '~/__tests__/mocks/logging.mock';
import {
  assertBountyEntryFileUrlAllowed,
  assertClientFileUrlAllowed,
  findClientFileUrlMiss,
  parseUploadObjectUrl,
} from '~/server/utils/model-file-url-bound';

/**
 * A client-set file url may name only the caller's own upload, a checkpoint copied to a version of
 * the same model, or the exact url of a live file on a model the caller owns now. Each case below
 * is paired with the nearest url that must be refused, so a rule that widens shows up as a pass
 * where a refusal was expected.
 */

const R2 = 'https://acct.r2.example.com';
const R2_BUCKET = 'uploads-r2';
const B2 = 'https://s3.us-west-004.backblazeb2.com';
const B2_BUCKET = 'uploads-b2';
const ME = 7;
const OTHER = 8;
const THIRD = 9;
const VERSION = 100; // the version the file is on
const SIBLING = 101; // another version of the same model
const FOREIGN = 200; // a version of someone else's model
const THEIRS_A = 300; // two versions of one model owned by someone else
const THEIRS_B = 301;

const r2Path = (key: string) => `${R2}/${R2_BUCKET}/${key}`;
const r2Virtual = (key: string) => `https://${R2_BUCKET}.acct.r2.example.com/${key}`;
const b2Path = (key: string) => `${B2}/${B2_BUCKET}/${key}`;
const b2Virtual = (key: string) => `https://${B2_BUCKET}.s3.us-west-004.backblazeb2.com/${key}`;

// version id -> model id
const versions = new Map([
  [VERSION, 1],
  [SIBLING, 1],
  [FOREIGN, 2],
  [THEIRS_A, 3],
  [THEIRS_B, 3],
]);
// model id -> current owner
const modelOwners = new Map([
  [1, ME],
  [2, OTHER],
  [3, OTHER],
]);
let files: { url: string; ownerId: number; replacedAt: Date | null }[];

type FileWhere = { url: string; replacedAt?: null; modelVersion?: { model?: { userId?: number } } };
type VersionWhere = {
  id: number;
  model: { userId?: number; modelVersions: { some: { id: number } } };
};

beforeEach(() => {
  vi.clearAllMocks();
  envMock.set({
    S3_UPLOAD_ENDPOINT: R2,
    S3_UPLOAD_BUCKET: R2_BUCKET,
    S3_UPLOAD_B2_ENDPOINT: B2,
    S3_UPLOAD_B2_BUCKET: B2_BUCKET,
  });
  files = [];
  // Filters apply only when the query states them, so a query that drops one matches more rows.
  dbMock.dbWrite.modelFile.findFirst.mockImplementation(async ({ where }: { where: FileWhere }) => {
    const owner = where.modelVersion?.model?.userId;
    const hit = files.find(
      (f) =>
        f.url === where.url &&
        (where.replacedAt !== null || f.replacedAt === null) &&
        (owner === undefined || f.ownerId === owner)
    );
    return hit ? { id: 1 } : null;
  });
  dbMock.dbWrite.modelVersion.findFirst.mockImplementation(
    async ({ where }: { where: VersionWhere }) => {
      const model = versions.get(where.id);
      const owner = where.model.userId;
      return model !== undefined &&
        model === versions.get(where.model.modelVersions.some.id) &&
        (owner === undefined || modelOwners.get(model) === owner)
        ? { id: where.id }
        : null;
    }
  );
});

const miss = (url: string, userId = ME, modelVersionId = VERSION) =>
  findClientFileUrlMiss({ url, userId, modelVersionId });

describe('rule 1: the caller own upload prefix', () => {
  it.each([
    ['R2 path-style', r2Path],
    ['R2 virtual-host', r2Virtual],
    ['B2 path-style', b2Path],
    ['B2 virtual-host', b2Virtual],
  ])('allows %s under <type>/<me>/', async (_form, at) => {
    await expect(miss(at(`model/${ME}/flux.abcd.safetensors`))).resolves.toBeNull();
    await expect(miss(at(`training-images/${ME}/set.abcd.zip`))).resolves.toBeNull();
  });

  it.each([
    ['R2 path-style', r2Path],
    ['R2 virtual-host', r2Virtual],
    ['B2 path-style', b2Path],
    ['B2 virtual-host', b2Virtual],
  ])('refuses %s under another user prefix', async (_form, at) => {
    await expect(miss(at(`model/${OTHER}/flux.abcd.safetensors`))).resolves.toBe(
      'other-user-prefix'
    );
  });

  it('matches the user id segment exactly, not as a prefix of a longer id', async () => {
    await expect(miss(r2Path(`default/${ME}0/x.bin`))).resolves.toBe('other-user-prefix');
    await expect(miss(r2Path(`default/0${ME}/x.bin`))).resolves.toBe('unrecognised-key');
  });

  it('refuses a key that is not under any upload prefix', async () => {
    await expect(miss(r2Path(`x.bin`))).resolves.toBe('unrecognised-key');
    await expect(miss(r2Path(`imports/${ME}/x.bin`))).resolves.toBe('unrecognised-key');
  });

  it('refuses an allowlisted bucket that new uploads do not land in', async () => {
    await expect(miss(`${R2}/civitai-prod/model/${ME}/x.bin`)).resolves.toBe('not-upload-bucket');
  });
});

describe('rule 2: a checkpoint copied to a version of the same model', () => {
  it.each([
    ['the file own version', VERSION],
    ['a sibling version', SIBLING],
  ])('allows modelVersion/<id>/ of %s', async (_label, id) => {
    await expect(miss(r2Virtual(`modelVersion/${id}/epoch_8.abcdefgh.safetensors`))).resolves.toBe(
      null
    );
  });

  it("refuses modelVersion/<id>/ of another model's version", async () => {
    await expect(miss(r2Virtual(`modelVersion/${FOREIGN}/epoch_8.safetensors`))).resolves.toBe(
      'other-model-version'
    );
  });

  // The create check runs before the version's ownership is, so its answer must not depend on how
  // versions the caller cannot edit relate to each other.
  it('gives the same answer for two versions of a model the caller does not own', async () => {
    const sameModel = miss(r2Virtual(`modelVersion/${THEIRS_B}/epoch.safetensors`), ME, THEIRS_A);
    const otherModel = miss(r2Virtual(`modelVersion/${FOREIGN}/epoch.safetensors`), ME, THEIRS_A);
    await expect(sameModel).resolves.toBe('other-model-version');
    await expect(otherModel).resolves.toBe('other-model-version');
  });

  it('refuses a version id with a leading zero rather than reading it as the same version', async () => {
    await expect(miss(r2Virtual(`modelVersion/0${VERSION}/epoch.safetensors`))).resolves.toBe(
      'unrecognised-key'
    );
  });
});

describe('rule 3: the exact url of a live file on a model the caller owns now', () => {
  const ORCHESTRATOR_ASSET = 'https://orchestration.example/v1/consumer/jobs/j1/assets/data.zip';

  it('allows a url outside every prefix rule when the caller owns a live file with it', async () => {
    files = [{ url: ORCHESTRATOR_ASSET, ownerId: ME, replacedAt: null }];
    await expect(miss(ORCHESTRATOR_ASSET)).resolves.toBeNull();
  });

  it('refuses the same url when the model was transferred to someone else', async () => {
    files = [{ url: ORCHESTRATOR_ASSET, ownerId: OTHER, replacedAt: null }];
    await expect(miss(ORCHESTRATOR_ASSET)).resolves.toBe('unknown-host');
    await expect(miss(ORCHESTRATOR_ASSET, OTHER)).resolves.toBeNull();
  });

  it('refuses a url only a replaced file still carries', async () => {
    files = [{ url: ORCHESTRATOR_ASSET, ownerId: ME, replacedAt: new Date() }];
    await expect(miss(ORCHESTRATOR_ASSET)).resolves.toBe('unknown-host');
  });

  it('is exact: a variant of an owned url is not covered', async () => {
    const owned = r2Path(`default/${OTHER}/x.bin`);
    files = [{ url: owned, ownerId: ME, replacedAt: null }];
    await expect(miss(owned)).resolves.toBeNull();
    await expect(miss(r2Virtual(`default/${OTHER}/x.bin`))).resolves.toBe('other-user-prefix');
    await expect(miss(`${owned}?x=1`)).resolves.toBe('non-canonical');
  });
});

describe('urls refused before any rule is matched', () => {
  const own = `default/${ME}/x.bin`;
  it.each([
    ['a query string', `${r2Path(own)}?versionId=1`, 'non-canonical'],
    ['a fragment', `${r2Path(own)}#x`, 'non-canonical'],
    ['a dot-dot segment', r2Path(`default/${ME}/../${OTHER}/x.bin`), 'non-canonical'],
    ['an encoded dot-dot segment', r2Path(`default/${ME}/%2e%2e/${OTHER}/x.bin`), 'non-canonical'],
    ['a dot segment', r2Path(`default/./${ME}/x.bin`), 'non-canonical'],
    ['an empty segment', r2Path(`default//${ME}/x.bin`), 'non-canonical'],
    ['a backslash', r2Path(`default/${ME}\\..\\${OTHER}/x.bin`), 'non-canonical'],
    ['an encoded backslash', r2Path(`default/${ME}%5C..%5C${OTHER}/x.bin`), 'non-canonical'],
    ['a tab', r2Path(`default/${ME}/\tx.bin`), 'non-canonical'],
    ['user info', `https://u:p@acct.r2.example.com/${R2_BUCKET}/${own}`, 'non-canonical'],
    ['an unknown host', `https://files.example/${R2_BUCKET}/${own}`, 'unknown-host'],
    [
      'a look-alike host',
      `https://${R2_BUCKET}.acct.r2.example.com.evil.example/${own}`,
      'unknown-host',
    ],
    [
      'a nested host under the bucket',
      `https://x.${R2_BUCKET}.acct.r2.example.com/${own}`,
      'unknown-host',
    ],
    ['another port', `https://acct.r2.example.com:8443/${R2_BUCKET}/${own}`, 'unknown-host'],
    ['plain http', `http://acct.r2.example.com/${R2_BUCKET}/${own}`, 'unknown-host'],
    ['not a url', 'model/7/x.bin', 'malformed'],
  ])('refuses %s', async (_label, url, reason) => {
    await expect(miss(url)).resolves.toBe(reason);
  });
});

// A large R2 upload comes back path-style with its whole key in one encoded segment.
describe('keys with encoded slashes are decoded once, then checked', () => {
  it('allows the observed form under the caller own prefix', async () => {
    await expect(miss(r2Path(`default%2F${ME}%2Fbig.abcd.safetensors`))).resolves.toBeNull();
  });

  it('refuses the same form under another user prefix', async () => {
    await expect(miss(r2Path(`default%2F${OTHER}%2Fbig.abcd.safetensors`))).resolves.toBe(
      'other-user-prefix'
    );
  });

  it('refuses a key that is still encoded after one decode', async () => {
    await expect(miss(r2Path(`default%252F${ME}%252Fbig.safetensors`))).resolves.toBe(
      'non-canonical'
    );
  });

  it('refuses dot segments that only appear once decoded', async () => {
    await expect(miss(r2Path(`default%2F${ME}%2F..%2F${OTHER}%2Fx.bin`))).resolves.toBe(
      'non-canonical'
    );
  });

  // Storage takes a path-style bucket from the raw path; one that only decodes to an upload bucket is
  // not one.
  it.each([
    ['R2', R2],
    ['B2', B2],
  ])(
    'refuses a %s path-style bucket segment that carries an encoded slash',
    async (_store, host) => {
      const bucket = host === R2 ? R2_BUCKET : B2_BUCKET;
      await expect(
        miss(`${host}/${bucket}%2Fdefault%2F${ME}/default/${OTHER}/x.bin`)
      ).resolves.toBe('unknown-host');
    }
  );

  it('allows a space once decoded, which an uploaded file name can carry', async () => {
    await expect(miss(r2Path(`default/${ME}/x.safe%20tensors`))).resolves.toBeNull();
    await expect(miss(r2Path(`default/${ME}/x.safe tensors`))).resolves.toBe('non-canonical');
  });

  it('parses the encoded and plain path-style forms of one object to the same key', () => {
    const encoded = parseUploadObjectUrl(r2Path(`default%2F${ME}%2Fx.bin`));
    const plain = parseUploadObjectUrl(r2Path(`default/${ME}/x.bin`));
    const virtual = parseUploadObjectUrl(r2Virtual(`default/${ME}/x.bin`));
    expect(encoded).toEqual({ ok: true, bucket: R2_BUCKET, key: `default/${ME}/x.bin` });
    expect(plain).toEqual(encoded);
    expect(virtual).toEqual(encoded);
  });
});

describe('assertClientFileUrlAllowed', () => {
  const foreign = r2Path(`default/${OTHER}/x.bin`);
  const call = (isModerator: boolean) =>
    assertClientFileUrlAllowed({
      url: foreign,
      userId: ME,
      isModerator,
      modelVersionId: VERSION,
      op: 'create',
    });

  it('lets a moderator set any url, without a lookup', async () => {
    await expect(call(true)).resolves.toBeUndefined();
    expect(dbMock.dbWrite.modelFile.findFirst).not.toHaveBeenCalled();
  });

  it('refuses a non-moderator with a BAD_REQUEST that does not repeat the url', async () => {
    const error = await call(false).catch((e: unknown) => e);
    expect(error).toMatchObject({ code: 'BAD_REQUEST' });
    expect((error as Error).message).toMatch(/upload the file again/i);
    expect((error as Error).message).not.toContain(OTHER.toString());
  });

  it('logs the refusal with the caller and the rule it missed', async () => {
    await call(false).catch(() => undefined);
    expect(loggingMock.logToAxiom).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'warning',
        name: 'model-file-url-refused',
        userId: ME,
        reason: 'other-user-prefix',
        op: 'create',
      })
    );
  });
});

describe('assertBountyEntryFileUrlAllowed', () => {
  const AUTHOR = OTHER; // the entry's author; ME awards the entry and creates the version
  const ENTRY = 55;
  const check = (url: string) =>
    assertBountyEntryFileUrlAllowed({ url, authorId: AUTHOR, userId: ME, bountyEntryId: ENTRY });

  it.each([
    ['in the upload bucket, path style', r2Path(`default/${AUTHOR}/lora.safetensors`)],
    ['in the upload bucket, virtual host', r2Virtual(`default/${AUTHOR}/lora.safetensors`)],
    [
      'as a large upload with its slashes encoded',
      `${R2}/${R2_BUCKET}/default%2F${AUTHOR}%2Fl.zip`,
    ],
    ['in the second upload bucket', b2Path(`default/${AUTHOR}/lora.safetensors`)],
  ])("copies the author's own upload %s", (_, url) => {
    expect(() => check(url)).not.toThrow();
  });

  it.each([
    ["another user's upload", r2Path(`default/${THIRD}/lora.safetensors`), 'other-user-prefix'],
    [
      "the awarder's own upload, which the author did not make",
      r2Path(`default/${ME}/lora.safetensors`),
      'other-user-prefix',
    ],
    [
      'a checkpoint copied to a version',
      r2Path(`modelVersion/${VERSION}/lora.safetensors`),
      'other-model-version',
    ],
    [
      'a bucket no upload goes to',
      `${B2}/retired-2023/default/${AUTHOR}/lora.safetensors`,
      'not-upload-bucket',
    ],
    [
      'a host that is not our storage',
      `https://files.example.com/default/${AUTHOR}/l.zip`,
      'unknown-host',
    ],
  ])('refuses %s, and logs why', (_, url, reason) => {
    expect(() => check(url)).toThrowError(/can't be copied into a model version/);
    expect(loggingMock.logToAxiom).toHaveBeenCalledWith(
      expect.objectContaining({
        name: 'model-file-url-refused',
        op: 'bounty-award',
        userId: ME,
        authorId: AUTHOR,
        bountyEntryId: ENTRY,
        reason,
      })
    );
  });

  it('refuses a file on an entry with no author', () => {
    expect(() =>
      assertBountyEntryFileUrlAllowed({
        url: r2Path(`default/${AUTHOR}/lora.safetensors`),
        authorId: null,
        userId: ME,
        bountyEntryId: ENTRY,
      })
    ).toThrowError(/can't be copied into a model version/);
  });
});
