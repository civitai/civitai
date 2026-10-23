import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.hoisted(() => {
  process.env.NEXTAUTH_SECRET = `worker-admin-test-${Math.random()}`;
});

import { generateSecretHash } from '@civitai/auth/secret-hash';
import { TokenScope } from '@civitai/auth/token-scope';
import { createKyselyFake } from '../../../../test/kysely-fake';
import { blockWorkerDevice, createWorkerClient } from '../worker-admin';

const DEVICE_ID = 'urn:civitai:token-type:device-id';
const JWT = 'urn:ietf:params:oauth:token-type:jwt';

type Row = Record<string, unknown>;
let tables: Record<string, Row[]>;
let db: never;

beforeEach(() => {
  tables = {
    UserRole: [
      { userId: 900, role: 'system:workload' },
      { userId: 5, role: 'tester' },
    ],
    OauthClient: [],
    WorkerClient: [],
    WorkerDevice: [
      { id: 1, clientId: 'workers-salad', status: 'active' },
      { id: 2, clientId: 'workers-salad', status: 'active' },
    ],
    ApiKey: [
      { id: 10, type: 'Worker', workerDeviceId: 1 },
      { id: 11, type: 'Worker', workerDeviceId: 1 },
      { id: 12, type: 'Worker', workerDeviceId: 2 },
      { id: 13, type: 'Access', workerDeviceId: null },
    ],
  };
  db = createKyselyFake(tables) as never;
});

describe('createWorkerClient', () => {
  it('registers a confidential token-exchange client owned by the system account', async () => {
    const { clientId, secret } = await createWorkerClient(db, {
      id: 'workers-salad',
      name: 'Salad workers',
      provider: 'salad',
      subjectTokenTypes: [JWT],
      saladContainerGroupIds: ['group-a'],
    });

    expect(clientId).toBe('workers-salad');
    expect(secret).toMatch(/^[0-9a-f]{64}$/);
    expect(tables.OauthClient).toEqual([
      expect.objectContaining({
        id: 'workers-salad',
        secret: generateSecretHash(secret),
        grants: ['urn:ietf:params:oauth:grant-type:token-exchange'],
        allowedScopes: TokenScope.WorkerRegister,
        isConfidential: true,
        userId: 900,
      }),
    ]);
    expect(tables.WorkerClient).toEqual([
      expect.objectContaining({
        clientId: 'workers-salad',
        provider: 'salad',
        subjectTokenTypes: [JWT],
        saladContainerGroupIds: ['group-a'],
      }),
    ]);
  });

  it.each([
    ['a client id with "+"', { id: 'workers+salad', subjectTokenTypes: [DEVICE_ID] }, /client id/],
    [
      'a client id with "%"',
      { id: 'workers%2Bsalad', subjectTokenTypes: [DEVICE_ID] },
      /client id/,
    ],
    ['no accepted types', { subjectTokenTypes: [] }, /at least one/],
    ['an unknown type', { subjectTokenTypes: ['urn:other'] }, /unknown subject token type/],
    [
      'device ids on a Salad pool',
      { subjectTokenTypes: [DEVICE_ID, JWT], saladContainerGroupIds: ['group-a'] },
      /cannot accept device ids/,
    ],
    ['Salad tokens without a group', { subjectTokenTypes: [JWT] }, /needs at least one/],
  ])('refuses %s, writing nothing', async (_, over, error) => {
    await expect(
      createWorkerClient(db, { id: 'x', name: 'x', provider: 'x', ...over })
    ).rejects.toThrow(error);
    expect(tables.OauthClient).toHaveLength(0);
    expect(tables.WorkerClient).toHaveLength(0);
  });

  it('refuses unless exactly one account holds the system role', async () => {
    tables.UserRole.push({ userId: 901, role: 'system:workload' });
    await expect(
      createWorkerClient(db, { id: 'x', name: 'x', provider: 'x', subjectTokenTypes: [DEVICE_ID] })
    ).rejects.toThrow(/found 2/);

    tables.UserRole.splice(0, tables.UserRole.length);
    await expect(
      createWorkerClient(db, { id: 'x', name: 'x', provider: 'x', subjectTokenTypes: [DEVICE_ID] })
    ).rejects.toThrow(/found 0/);
    expect(tables.OauthClient).toHaveLength(0);
  });
});

describe('blockWorkerDevice', () => {
  it("blocks the device and deletes only that device's Worker tokens", async () => {
    expect(await blockWorkerDevice(db, 1, 'stolen')).toEqual({ tokensDeleted: 2 });
    expect(tables.WorkerDevice[0]).toMatchObject({ status: 'blocked', blockedReason: 'stolen' });
    expect(tables.WorkerDevice[1]).toMatchObject({ status: 'active' });
    expect(tables.ApiKey.map((r) => r.id)).toEqual([12, 13]);
  });

  it('throws for an unknown device and changes nothing', async () => {
    await expect(blockWorkerDevice(db, 99, 'x')).rejects.toThrow(/No worker device 99/);
    expect(tables.ApiKey).toHaveLength(4);
  });
});
