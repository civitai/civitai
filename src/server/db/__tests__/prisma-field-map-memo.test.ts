import { PrismaClient } from '@prisma/client';
import { afterEach, describe, expect, it } from 'vitest';

// Guards patches/@prisma__client@6.13.0.patch. No database is touched: `_request` is stubbed, so
// every assertion is about what the client hands to the engine, not what the engine returns.

type RuntimeField = { name: string; kind: string; type: string };
type RuntimeModel = { fields: RuntimeField[] };
type RequestParams = {
  model: string;
  action: string;
  dataPath: string[];
  args: unknown;
  clientMethod: string;
};
type InternalClient = PrismaClient & {
  _runtimeDataModel: { models: Record<string, RuntimeModel> };
  _request: (params: RequestParams) => Promise<unknown>;
};

const restores: Array<() => void> = [];
afterEach(() => {
  while (restores.length) restores.pop()?.();
});

function makeClient() {
  const client = new PrismaClient({
    datasourceUrl: 'postgresql://unused:unused@127.0.0.1:1/unused',
  }) as InternalClient;
  const requests: RequestParams[] = [];
  client._request = async (params) => {
    requests.push(params);
    return { stubbed: params.clientMethod };
  };
  return { client, requests };
}

// Counts element reads of a model's field list, i.e. how often something walks it.
function countFieldReads(client: InternalClient, modelName: string) {
  const model = client._runtimeDataModel.models[modelName];
  const original = model.fields;
  let reads = 0;
  model.fields = new Proxy(original, {
    get(target, key, receiver) {
      if (typeof key === 'string' && /^\d+$/.test(key)) reads++;
      return Reflect.get(target, key, receiver);
    },
  });
  restores.push(() => {
    model.fields = original;
  });
  return { fieldCount: original.length, reads: () => reads };
}

describe('Prisma per-model field map', () => {
  it('is not rebuilt each time a single-record method is resolved', () => {
    const { client } = makeClient();
    const user = countFieldReads(client, 'User');
    expect(user.fieldCount).toBeGreaterThan(100);

    const accesses = 50;
    for (let i = 0; i < accesses; i++) {
      expect(typeof client.user.findUnique).toBe('function');
      expect(typeof client.user.findFirst).toBe('function');
      expect(typeof client.user.update).toBe('function');
    }

    // Exactly one build: the Proxy is a fresh cache key, so this also proves the counter sees
    // the walk. Unpatched 6.13.0 walks all fields on every access: 150 * fieldCount.
    expect(user.reads()).toBe(user.fieldCount);
  });

  // Smoke check: a non-fluent call never reads the map, so this cannot catch a wrong one.
  it('still sends a plain single-record call on a wide model', async () => {
    const { client, requests } = makeClient();

    await expect(
      client.user.findUnique({ where: { id: 1 }, select: { id: true, username: true } })
    ).resolves.toEqual({ stubbed: 'user.findUnique' });

    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({
      model: 'User',
      action: 'findUnique',
      dataPath: [],
      args: { where: { id: 1 }, select: { id: true, username: true } },
      clientMethod: 'user.findUnique',
    });
  });

  it('resolves fluent relation hops through the right models, repeatedly', async () => {
    const { client, requests } = makeClient();
    const image = countFieldReads(client, 'Image');

    for (let i = 0; i < 3; i++) {
      await client.image
        .findUnique({ where: { id: 7 } })
        .user()
        .profile();
    }

    expect(requests).toHaveLength(3);
    for (const request of requests) {
      expect(request).toMatchObject({
        model: 'Image',
        action: 'findUnique',
        dataPath: ['select', 'user', 'select', 'profile'],
        args: { where: { id: 7 }, select: { user: { select: { profile: true } } } },
      });
    }
    // Upstream walks the list once per call to find relation names (3 walks); one build on top of
    // that is expected. Unpatched 6.13.0 adds a rebuild per call: 6 walks.
    expect(image.reads()).toBeGreaterThan(3 * image.fieldCount);
    expect(image.reads()).toBeLessThan(6 * image.fieldCount);
  });

  it('resolves each fluent hop to the target model, not the source', async () => {
    const { client, requests } = makeClient();

    // `profilePicture` is a relation on User only, `post` on Image only.
    const fromImage = client.image.findUnique({ where: { id: 2 } }).user() as unknown as Record<
      string,
      unknown
    >;
    expect(typeof fromImage.profilePicture).toBe('function');
    expect(fromImage.post).toBeUndefined();

    await client.user
      .findUnique({ where: { id: 1 } })
      .profilePicture()
      .user();
    await client.image
      .findUnique({ where: { id: 2 } })
      .user()
      .profilePicture();

    expect(requests.map((r) => [r.model, r.dataPath.join('.')])).toEqual([
      ['User', 'select.profilePicture.select.user'],
      ['Image', 'select.user.select.profilePicture'],
    ]);
  });
});
