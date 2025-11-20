import type { ClickHouseClient } from '@clickhouse/client';
import { createClient } from '@clickhouse/client';
import { isProd } from '~/env/other';
import { env } from '~/env/server';
import dayjs from '~/shared/utils/dayjs';
import { createLogger } from '~/utils/logging';

export type CustomClickHouseClient = ClickHouseClient & {
  $query: <T extends object>(
    query: TemplateStringsArray | string,
    ...values: any[]
  ) => Promise<T[]>;
  $exec: (query: TemplateStringsArray | string, ...values: any[]) => Promise<void>;
};

declare global {
  // eslint-disable-next-line no-var, vars-on-top
  var globalClickhouse: CustomClickHouseClient | undefined;
}

const log = createLogger('clickhouse', 'blue');

function getClickHouse() {
  console.log('Creating ClickHouse client');
  const client = createClient({
    host: env.CLICKHOUSE_HOST,
    username: env.CLICKHOUSE_USERNAME,
    password: env.CLICKHOUSE_PASSWORD,
    clickhouse_settings: {
      async_insert: 1,
      wait_for_async_insert: 0,
      output_format_json_quote_64bit_integers: 0, // otherwise they come as strings
    },
  }) as CustomClickHouseClient;

  client.$query = async function <T extends object>(
    query: TemplateStringsArray | string,
    ...values: any[]
  ) {
    if (typeof query !== 'string') {
      query = query.reduce((acc, part, i) => acc + part + formatSqlType(values[i] ?? ''), '');
    }

    log('$query', query);

    const response = await client.query({
      query,
      format: 'JSONEachRow',
    });
    const data = await response?.json<T>();
    return data;
  };

  client.$exec = async function (query: TemplateStringsArray | string, ...values: any[]) {
    if (typeof query !== 'string') {
      query = query.reduce((acc, part, i) => acc + part + formatSqlType(values[i] ?? ''), '');
    }

    log('$exec', query);

    await client.exec({
      query,
    });
  };

  return client;
}

export let clickhouse: CustomClickHouseClient | undefined;
const shouldConnect = !env.IS_BUILD && env.CLICKHOUSE_HOST && env.CLICKHOUSE_USERNAME;
if (shouldConnect) {
  if (isProd) clickhouse = getClickHouse();
  else {
    if (!global.globalClickhouse) global.globalClickhouse = getClickHouse();
    clickhouse = global.globalClickhouse;
  }

  // Set the clickhouse client for the Tracker to avoid circular dependency
  if (clickhouse) {
    import('./tracker').then(({ setClickhouseClient }) => {
      setClickhouseClient(clickhouse);
    }).catch(() => {
      // Ignore errors - tracker may not be initialized yet
    });
  }
}

function formatSqlType(value: any): string {
  // Catch any dates being passed in as a string
  if (
    typeof value === 'string' &&
    (value.endsWith('(Coordinated Universal Time)') || /\.\d{3}Z$/.test(value))
  ) {
    value = new Date(value);
  }
  if (value instanceof Date) return "parseDateTimeBestEffort('" + dayjs(value).toISOString() + "')";
  if (typeof value === 'object') {
    if (Array.isArray(value)) return value.map(formatSqlType).join(',');
    if (value === null) return 'null';
    return JSON.stringify(value);
  }

  return value;
}

// Re-export Tracker and related types from tracker.ts to avoid circular dependencies
export { Tracker } from './tracker';
export type {
  ViewType,
  UserActivityType,
  ModelVersionActivty,
  ModelActivty,
  ResourceReviewType,
  ReactionType,
  ReportType,
  ModelEngagementType,
  TagEngagementType,
  UserEngagementType,
  CommentType,
  CommentActivity,
  PostActivityType,
  ImageActivityType,
  QuestionType,
  AnswerType,
  PartnerActivity,
  BountyActivity,
  BountyEntryActivity,
  BountyBenefactorActivity,
  FileActivity,
  ModelFileActivity,
  ActionType,
  TrackRequest,
} from './tracker';
