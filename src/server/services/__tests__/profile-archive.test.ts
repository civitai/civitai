import { createHash } from 'crypto';
import { GetObjectCommand, PutObjectCommand } from '@aws-sdk/client-s3';
import type { S3Client } from '@aws-sdk/client-s3';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { dbMock } from '~/__tests__/mocks/db.mock';
import { storeVerifiedProfileArchive } from '~/server/services/profile-archive';
import { clearUserProfileFields, type ProfileClearSnapshot } from '~/server/services/user.service';

const USER = 990400001;
const MOD = 990400002;
const BUCKET = 'csam-test';
const OLD_BIO = 'pay me at example.invalid/tip';

type Stored = { body: Buffer; metadata: Record<string, string> | undefined };

/** An S3 bucket in memory. `corrupt` alters what a read returns; `failPut` refuses writes. */
function fakeBucket() {
  const objects = new Map<string, Stored>();
  const bucket = {
    objects,
    failPut: undefined as Error | undefined,
    corrupt: undefined as ((b: Buffer) => Buffer) | undefined,
    client: {
      send: async (command: unknown) => {
        if (command instanceof PutObjectCommand) {
          if (bucket.failPut) throw bucket.failPut;
          const { Key, Body, Metadata, Bucket } = command.input;
          expect(Bucket).toBe(BUCKET);
          objects.set(Key!, { body: Buffer.from(Body as Buffer), metadata: Metadata });
          return {};
        }
        if (command instanceof GetObjectCommand) {
          const found = objects.get(command.input.Key!);
          if (!found) throw new Error('NoSuchKey');
          const bytes = bucket.corrupt ? bucket.corrupt(found.body) : found.body;
          return {
            Metadata: found.metadata,
            Body: { transformToByteArray: async () => new Uint8Array(bytes) },
          };
        }
        throw new Error('unexpected command');
      },
    } as unknown as Pick<S3Client, 'send'>,
  };
  return bucket;
}

const sha256 = (b: Buffer) => createHash('sha256').update(b).digest('hex');

const snapshot: ProfileClearSnapshot = {
  userId: USER,
  actorId: MOD,
  clearedFields: ['bio'],
  links: [{ id: 1, url: 'https://example.invalid/pay', type: 'Sponsorship' }],
  profile: {
    bio: OLD_BIO,
    message: null,
    messageAddedAt: null,
    sfwBio: null,
    sfwMessage: null,
    location: null,
    showcaseSections: [],
    showcaseItems: [],
    about: null,
  },
};

let bucket: ReturnType<typeof fakeBucket>;
beforeEach(() => {
  vi.clearAllMocks();
  bucket = fakeBucket();
});

describe('storeVerifiedProfileArchive', () => {
  it('stores the snapshot with the sha256 of its exact bytes, checked on a re-read', async () => {
    const now = new Date('2026-11-21T09:30:00.000Z');
    const stored = await storeVerifiedProfileArchive({
      client: bucket.client,
      Bucket: BUCKET,
      snapshot,
      now,
    });

    const object = bucket.objects.get(stored.key)!;
    expect(stored.key).toBe(`${USER}/${now.getTime()}_profile.json`);
    expect(sha256(object.body)).toBe(stored.sha256);
    expect(object.metadata).toEqual({ sha256: stored.sha256 });
    expect(JSON.parse(object.body.toString('utf8'))).toEqual({
      userId: USER,
      archivedAt: '2026-11-21T09:30:00.000Z',
      actorId: MOD,
      clearedFields: ['bio'],
      profile: snapshot.profile,
      links: snapshot.links,
    });
  });

  it('rejects when the object reads back without its sha256', async () => {
    const send = bucket.client.send.bind(bucket.client);
    bucket.client.send = (async (command: unknown) => {
      const out = (await send(command as never)) as { Metadata?: unknown };
      return command instanceof GetObjectCommand ? { ...out, Metadata: {} } : out;
    }) as never;
    await expect(
      storeVerifiedProfileArchive({ client: bucket.client, Bucket: BUCKET, snapshot })
    ).rejects.toThrow(/does not match its sha256/);
  });

  it('rejects when the stored bytes read back differently', async () => {
    bucket.corrupt = (b) => Buffer.concat([b, Buffer.from(' ')]);
    await expect(
      storeVerifiedProfileArchive({ client: bucket.client, Bucket: BUCKET, snapshot })
    ).rejects.toThrow(/does not match its sha256/);
  });
});

describe('a moderator clear of a reported user, through the verified archive', () => {
  const db = dbMock.dbWrite;
  beforeEach(() => {
    db.$queryRaw.mockResolvedValue([{ named: true }] as never);
    db.userProfile.findUnique.mockResolvedValue(snapshot.profile as never);
    db.userLink.findMany.mockResolvedValue(snapshot.links as never);
    db.userProfile.updateMany.mockResolvedValue({ count: 1 } as never);
    db.$executeRaw.mockResolvedValue(1 as never);
  });
  const clearBio = () =>
    clearUserProfileFields({
      userId: USER,
      actorId: MOD,
      fields: ['bio'],
      archive: (s) =>
        storeVerifiedProfileArchive({ client: bucket.client, Bucket: BUCKET, snapshot: s }),
    });

  it('lands the old bio in the bucket, hash-verified, before clearing it', async () => {
    await expect(clearBio()).resolves.toEqual({ updated: true });

    const [[key, object]] = [...bucket.objects];
    expect(key.startsWith(`${USER}/`)).toBe(true);
    expect(object.metadata?.sha256).toBe(sha256(object.body));
    expect(JSON.parse(object.body.toString('utf8')).profile.bio).toBe(OLD_BIO);
    expect(db.userProfile.updateMany).toHaveBeenCalledTimes(1);
  });

  it('clears nothing when the upload fails', async () => {
    bucket.failPut = new Error('s3 down');
    await expect(clearBio()).rejects.toThrow('s3 down');
    expect(db.userProfile.updateMany).not.toHaveBeenCalled();
  });

  it('clears nothing when the re-read does not match the hash', async () => {
    bucket.corrupt = (b) => b.subarray(1);
    await expect(clearBio()).rejects.toThrow(/sha256/);
    expect(db.userProfile.updateMany).not.toHaveBeenCalled();
  });
});
