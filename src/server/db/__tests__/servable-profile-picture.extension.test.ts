import { describe, expect, it, vi } from 'vitest';
import { simpleUserSelect, userWithCosmeticsSelect } from '~/server/selectors/user.selector';
import {
  gateProfilePictures,
  servableProfilePictureExtension,
  withServableProfilePictures,
} from '~/server/db/servable-profile-picture.extension';

const picture = (ingestion: string) => ({ id: 1, url: `avatar-${ingestion}`, ingestion });
const user = (ingestion: string) => ({ id: 1, username: 'u', profilePicture: picture(ingestion) });

/** A find query returning `result`, recording the args it ran with. */
const queryReturning = <T>(result: T) => vi.fn(async (..._args: unknown[]) => result);

describe('the servable profile picture gate', () => {
  it.each(['Pending', 'Error', 'Blocked'])(
    'nulls a %s picture under a nested simpleUserSelect and keeps a Scanned one',
    async (state) => {
      const rows = [
        { id: 10, user: user(state) },
        { id: 11, user: user('Scanned') },
      ];
      const args = { select: { id: true, user: { select: simpleUserSelect } } };
      const result = await gateProfilePictures(args, queryReturning(rows), vi.fn());

      expect(result[0].user.profilePicture).toBeNull();
      expect(result[1].user.profilePicture?.url).toBe('avatar-Scanned');
    }
  );

  it('matches the select by shape, so a spread or hand-built copy is gated too', async () => {
    const copies = [
      { ...simpleUserSelect },
      { ...userWithCosmeticsSelect },
      { id: true, profilePicture: { select: { id: true, url: true, ingestion: true } } },
      { id: true, profilePicture: true },
    ];
    for (const select of copies) {
      const result = await gateProfilePictures(
        { include: { user: { select } } },
        queryReturning({ id: 1, user: user('Pending') }),
        vi.fn()
      );
      expect(result.user.profilePicture).toBeNull();
    }
  });

  it('gates a user read itself and every nesting depth', async () => {
    const top = await gateProfilePictures(
      { where: { id: 1 }, select: simpleUserSelect },
      queryReturning(user('Pending')),
      vi.fn()
    );
    expect(top.profilePicture).toBeNull();

    const deep = await gateProfilePictures(
      { select: { post: { select: { user: { select: simpleUserSelect } } } } },
      queryReturning([{ post: { user: user('Pending') } }, { post: null }]),
      vi.fn()
    );
    expect(deep[0].post?.user.profilePicture).toBeNull();
  });

  it('adds ingestion to a picture select that lacks it, and strips it from the result', async () => {
    const select = { id: true, profilePicture: { select: { id: true, url: true } } };
    const query = vi.fn(async (args: unknown) => {
      const sent = (args as { select: { profilePicture: { select: Record<string, boolean> } } })
        .select.profilePicture.select;
      expect(sent.ingestion).toBe(true);
      return [user('Scanned'), user('Pending')];
    });

    const result = await gateProfilePictures({ select }, query, vi.fn());

    expect(result[0].profilePicture).toEqual({ id: 1, url: 'avatar-Scanned' });
    // needsReview, added the same way, is stripped too.
    expect(result[1].profilePicture).toBeNull();
    // The caller's select, often a shared module constant, is not changed.
    expect(select.profilePicture.select).toEqual({ id: true, url: true });
  });

  it('nulls a Scanned picture held csam or minor, reading needsReview even when the select omits it', async () => {
    const query = vi.fn(async (args: unknown) => {
      const sent = (args as { select: { profilePicture: { select: Record<string, boolean> } } })
        .select.profilePicture.select;
      expect(sent.needsReview).toBe(true);
      return [
        { profilePicture: { ...picture('Scanned'), needsReview: 'csam' } },
        { profilePicture: { ...picture('Scanned'), needsReview: null } },
        { profilePicture: { ...picture('Scanned'), needsReview: 'minor' } },
        { profilePicture: { ...picture('Scanned'), needsReview: 'poi' } },
      ];
    });

    const result = await gateProfilePictures({ select: simpleUserSelect }, query, vi.fn());

    expect(result[0].profilePicture).toBeNull();
    expect(result[1].profilePicture).toEqual(picture('Scanned'));
    expect(result[2].profilePicture).toBeNull();
    expect(result[3].profilePicture).toEqual(picture('Scanned'));
  });

  it('nulls a sibling image naming a held picture, keeps one naming nothing held', async () => {
    const held = (needsReview: string) => ({ ...picture('Scanned'), nsfwLevel: 1, needsReview });
    const rows = [
      { image: 'https://cdn.example/AVATAR-SCANNED/width=96', profilePicture: held('csam') },
      { image: 'avatar%2dScanned', profilePicture: held('minor') },
      { image: 'legacy', profilePicture: held('csam') },
      { image: 'avatar-Pending', profilePicture: { ...picture('Pending'), nsfwLevel: 1 } },
    ];

    const result = await gateProfilePictures(
      { select: simpleUserSelect },
      queryReturning(rows),
      vi.fn()
    );

    expect(result.map((row) => row.image)).toEqual([null, null, 'legacy', 'avatar-Pending']);
    expect(result.every((row) => row.profilePicture === null)).toBe(true);
  });

  it('nulls a mature picture made with a restricted base model, keeping a SFW one', async () => {
    const query = vi.fn(async (args: unknown) => {
      const sent = (args as { select: { profilePicture: { select: Record<string, boolean> } } })
        .select.profilePicture.select;
      expect(sent.modelRestricted).toBe(true);
      return [
        { profilePicture: { ...picture('Scanned'), nsfwLevel: 4, modelRestricted: true } },
        { profilePicture: { ...picture('Scanned'), nsfwLevel: 1, modelRestricted: true } },
        { profilePicture: { ...picture('Scanned'), nsfwLevel: 4, modelRestricted: false } },
      ];
    });

    const result = await gateProfilePictures({ select: simpleUserSelect }, query, vi.fn());

    expect(result.map((row) => row.profilePicture?.nsfwLevel ?? null)).toEqual([null, 1, 4]);
    expect(result[1].profilePicture).not.toHaveProperty('modelRestricted');
  });

  it('nulls an unrated Scanned picture, reading nsfwLevel even when the select omits it', async () => {
    const select = { id: true, profilePicture: { select: { id: true, url: true } } };
    const query = vi.fn(async (args: unknown) => {
      const sent = (args as { select: { profilePicture: { select: Record<string, boolean> } } })
        .select.profilePicture.select;
      expect(sent.nsfwLevel).toBe(true);
      return [
        { profilePicture: { ...picture('Scanned'), nsfwLevel: 0 } },
        { profilePicture: { ...picture('Scanned'), nsfwLevel: 1 } },
      ];
    });

    const result = await gateProfilePictures({ select }, query, vi.fn());

    expect(result[0].profilePicture).toBeNull();
    // The fields the gate added are stripped again.
    expect(result[1].profilePicture).toEqual({ id: 1, url: 'avatar-Scanned' });
  });

  it('un-omits the fields it checks on a whole-row picture, and removes them again', async () => {
    const query = vi.fn(async (args: unknown) => {
      expect(
        (args as { include: { profilePicture: { omit: unknown } } }).include.profilePicture.omit
      ).toEqual({
        ingestion: false,
        url: true,
      });
      return { profilePicture: { id: 1, ingestion: 'Scanned', needsReview: null } };
    });

    const result = await gateProfilePictures(
      { include: { profilePicture: { omit: { ingestion: true, url: true } } } },
      query,
      vi.fn()
    );

    expect(result.profilePicture).toEqual({ id: 1, needsReview: null });
  });

  it('passes a query without a servable picture through untouched: same args, same result', async () => {
    const withoutPicture = [
      { where: { id: 1 } },
      { select: { id: true, username: true } },
      { include: { posts: { select: { id: true } } } },
      // An ownership check: a picture select without `url` carries nothing servable.
      { select: { profilePicture: { select: { userId: true } } } },
      undefined,
    ];
    for (const args of withoutPicture) {
      const rows = [{ id: 1, profilePicture: { userId: 1, ingestion: 'Pending' } }];
      const query = queryReturning(rows);
      const result = await gateProfilePictures(args, query, vi.fn());

      expect(result).toBe(rows);
      expect(result[0].profilePicture).toBe(rows[0].profilePicture);
      expect(query).toHaveBeenCalledTimes(1);
      expect(query.mock.calls[0][0]).toBe(args);
    }
  });

  it('lets a failing query fail as it would without the gate', async () => {
    const failure = new Error('db down');
    const onError = vi.fn();
    await expect(
      gateProfilePictures({ select: simpleUserSelect }, () => Promise.reject(failure), onError)
    ).rejects.toBe(failure);
    expect(onError).not.toHaveBeenCalled();
  });

  it('on its own error, reports it and nulls every picture instead of failing the query', async () => {
    const onError = vi.fn();
    const broken = Object.defineProperty({}, 'select', {
      enumerable: true,
      get() {
        throw new Error('unreadable args');
      },
    });
    const rows = [
      { id: 1, user: { ...user('Scanned'), image: 'avatar-Scanned' } },
      { id: 2, user: { ...user('Scanned'), image: 'legacy' } },
    ];

    const result = await gateProfilePictures(broken, queryReturning(rows), onError);

    expect(onError).toHaveBeenCalledTimes(1);
    expect(result[0].user.profilePicture).toBeNull();
    expect(result.map((row) => row.user.image)).toEqual([null, 'legacy']);
  });

  it('nulls every picture when it fails after the query returned', async () => {
    const onError = vi.fn();
    // A result the plan cannot read; the fallback can still overwrite it.
    let stored: unknown = picture('Pending');
    const row = Object.defineProperty({ id: 1 }, 'profilePicture', {
      enumerable: true,
      get() {
        if (stored === null) return null;
        throw new Error('unreadable result');
      },
      set(value) {
        stored = value;
      },
    });

    const result = await gateProfilePictures(
      { select: simpleUserSelect },
      queryReturning(row),
      onError
    );

    expect(onError).toHaveBeenCalledTimes(1);
    expect(stored).toBeNull();
    expect(result).toBe(row);
  });

  type Handler = (p: {
    args: unknown;
    query: (a: unknown) => Promise<unknown>;
  }) => Promise<unknown>;
  const registered = () =>
    (
      servableProfilePictureExtension(vi.fn())({
        $extends: (extension: unknown) => extension,
      } as never) as unknown as { query: { $allModels: Record<string, Handler> } }
    ).query.$allModels;

  it('registers no write handler, so writes return what they wrote', () => {
    const operations = Object.keys(registered());
    for (const write of [
      'create',
      'createMany',
      'createManyAndReturn',
      'update',
      'updateMany',
      'updateManyAndReturn',
      'upsert',
      'delete',
      'deleteMany',
      '$allOperations',
    ])
      expect(operations, write).not.toContain(write);
  });

  it('gates through every registered find handler', async () => {
    expect(Object.keys(registered()).sort()).toEqual([
      'findFirst',
      'findFirstOrThrow',
      'findMany',
      'findUnique',
      'findUniqueOrThrow',
    ]);
    for (const [operation, handler] of Object.entries(registered())) {
      const result = (await handler({
        args: { select: simpleUserSelect },
        query: async () => user('Pending'),
      })) as { profilePicture: unknown };
      expect(result.profilePicture, operation).toBeNull();
    }
  });

  it('extends the read and write clients, and keeps a shared client shared', () => {
    const client = (name: string) => ({ name, $extends: vi.fn(() => ({ name, extended: true })) });

    const split = withServableProfilePictures(
      { dbRead: client('read'), dbWrite: client('write') },
      vi.fn()
    );
    expect(split.dbRead).toEqual({ name: 'read', extended: true });
    expect(split.dbWrite).toEqual({ name: 'write', extended: true });

    const one = client('one');
    const shared = withServableProfilePictures({ dbRead: one, dbWrite: one }, vi.fn());
    expect(shared.dbRead).toBe(shared.dbWrite);
    expect(one.$extends).toHaveBeenCalledTimes(1);
  });
});
