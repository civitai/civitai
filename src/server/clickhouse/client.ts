import { createClient } from '@clickhouse/client';
import { env } from '~/env/server.mjs';

export const clickhouse = createClient({
  host: env.CLICKHOUSE_HOST,
  username: env.CLICKHOUSE_USERNAME,
  password: env.CLICKHOUSE_PASSWORD,
});
