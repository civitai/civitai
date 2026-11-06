import { createPrismaClients, type PrismaClients } from '@civitai/db/client';
import { Prisma, PrismaClient } from '@civitai/db-schema';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

/**
 * Every app Prisma client leaves `User.subscriptionId` off what it returns, so no read without a
 * `select` can hand it to a client. Against a real Postgres, because the omit is applied inside
 * Prisma's query engine, where no mock reaches.
 *
 * Runs in CI on the `unit` job's throwaway Postgres service, through the URL that job already sets
 * for the hot-reads-2 parity suite; the last test fails if that wiring is lost. Locally it skips
 * without a URL, which must point at a THROWAWAY database: the suite drops and recreates the
 * `prisma_client_omit` schema there.
 */
const databaseUrl =
  process.env.PRISMA_CLIENT_OMIT_DATABASE_URL ?? process.env.KYSELY_HOT_READS_2_PARITY_DATABASE_URL;
const SCHEMA = 'prisma_client_omit';
const USER_ID = 41;
const SUBSCRIPTION_ID = 'sub_zzfixture';

const withSchema = (url: string) => {
  const parsed = new URL(url);
  parsed.searchParams.set('schema', SCHEMA);
  return parsed.toString();
};

const PG_TYPES: Record<string, string> = {
  String: 'text',
  Int: 'integer',
  BigInt: 'bigint',
  Float: 'double precision',
  Decimal: 'numeric',
  Boolean: 'boolean',
  DateTime: 'timestamp(3)',
  Json: 'jsonb',
  Bytes: 'bytea',
};

const PG_DEFAULTS: Record<string, string> = {
  text: "''",
  integer: '0',
  bigint: '0',
  'double precision': '0',
  numeric: '0',
  boolean: 'false',
  'timestamp(3)': 'now()',
  jsonb: "'{}'",
  bytea: "''",
};

/**
 * Every column Prisma reads for the model, from the generated client, so the table cannot drift.
 * Prisma refuses a null in a required field, so each required column gets a default.
 */
function createTableSql(modelName: string) {
  const model = Prisma.dmmf.datamodel.models.find((m) => m.name === modelName);
  if (!model) throw new Error(`no ${modelName} model in the generated client`);
  const columns = model.fields
    .filter((f) => f.kind === 'scalar' || f.kind === 'enum')
    .map((f) => {
      const base = f.kind === 'enum' ? 'text' : PG_TYPES[f.type];
      if (!base) throw new Error(`no Postgres type for ${modelName}.${f.name} (${f.type})`);
      const enumDefault = Prisma.dmmf.datamodel.enums.find((e) => e.name === f.type)?.values[0];
      const fallback = f.isList
        ? "'{}'"
        : enumDefault
        ? `'${enumDefault.dbName ?? enumDefault.name}'`
        : PG_DEFAULTS[base];
      const required = f.isRequired || f.isList ? ` NOT NULL DEFAULT ${fallback}` : '';
      return `"${f.dbName ?? f.name}" ${base}${f.isList ? '[]' : ''}${required}`;
    });
  return `CREATE TABLE "${SCHEMA}"."${model.dbName ?? model.name}" (${columns.join(', ')})`;
}

describe.skipIf(!databaseUrl)('the app Prisma clients', () => {
  let admin: PrismaClient;
  let clients: PrismaClients;

  beforeAll(async () => {
    admin = new PrismaClient({ datasourceUrl: withSchema(databaseUrl as string) });
    await admin.$executeRawUnsafe(`DROP SCHEMA IF EXISTS "${SCHEMA}" CASCADE`);
    await admin.$executeRawUnsafe(`CREATE SCHEMA "${SCHEMA}"`);
    await admin.$executeRawUnsafe(createTableSql('User'));
    await admin.$executeRawUnsafe(createTableSql('UserProfile'));
    await admin.$executeRawUnsafe(
      `INSERT INTO "${SCHEMA}"."User" (id, username, "subscriptionId")
       VALUES (${USER_ID}, 'zzfixture', '${SUBSCRIPTION_ID}'), (${
        USER_ID + 1
      }, 'zzother', 'sub_other')`
    );
    await admin.$executeRawUnsafe(
      `INSERT INTO "${SCHEMA}"."UserProfile" ("userId") VALUES (${USER_ID})`
    );

    vi.stubEnv('DATABASE_URL', withSchema(databaseUrl as string));
    vi.stubEnv('DATABASE_REPLICA_URL', withSchema(databaseUrl as string));
    clients = createPrismaClients({ logging: [] });
  });

  afterAll(async () => {
    vi.unstubAllEnvs();
    await clients?.dbWrite.$disconnect();
    await clients?.dbRead.$disconnect();
    await admin?.$executeRawUnsafe(`DROP SCHEMA IF EXISTS "${SCHEMA}" CASCADE`);
    await admin?.$disconnect();
  });

  it('leave the subscription id off a user read with no select', async () => {
    const user = await clients.dbRead.user.findFirst({ where: { id: USER_ID } });
    expect(user).toMatchObject({ id: USER_ID, username: 'zzfixture' });
    expect(user).not.toHaveProperty('subscriptionId');
  });

  it('leave it off every row of a read that returns many', async () => {
    const users = await clients.dbRead.user.findMany({ orderBy: { id: 'asc' } });
    expect(users.map((u) => u.id)).toEqual([USER_ID, USER_ID + 1]);
    for (const user of users) expect(user).not.toHaveProperty('subscriptionId');
  });

  it('leave it off a user included whole through a relation', async () => {
    const profile = await clients.dbWrite.userProfile.findFirst({
      where: { userId: USER_ID },
      include: { user: true },
    });
    expect(profile?.user).toMatchObject({ id: USER_ID });
    expect(profile?.user).not.toHaveProperty('subscriptionId');
  });

  it('leave it off a read inside a transaction', async () => {
    const user = await clients.dbWrite.$transaction((tx) =>
      tx.user.findUniqueOrThrow({ where: { id: USER_ID } })
    );
    expect(user).toMatchObject({ id: USER_ID });
    expect(user).not.toHaveProperty('subscriptionId');
  });

  it('still return it to a read that asks for it', async () => {
    const user = await clients.dbRead.user.findFirst({
      where: { id: USER_ID },
      omit: { subscriptionId: false },
    });
    expect(user?.subscriptionId).toBe(SUBSCRIPTION_ID);
  });
});

// GitHub Actions only: the `unit` job there is the one wired with the database.
it.runIf(process.env.GITHUB_ACTIONS === 'true')('runs in CI: the omit database is wired', () => {
  expect(databaseUrl).toBeTruthy();
});
