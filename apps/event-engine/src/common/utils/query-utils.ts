import { IClickhouseClient, IRedisClient, IRedisMulti } from '../types/package-stubs';
import { logger } from './logger';

export class SimpleClickhouse {
  constructor(private ch: IClickhouseClient) {}

  public async query<T extends object>(query: TemplateStringsArray | string, ...values: any[]): Promise<T[]> {
    if (typeof query !== 'string') {
      query = query.reduce((acc, part, i) => acc + part + this.formatSqlType(values[i] ?? ''), '');
    }

    const response = await this.ch.query({
      query,
      format: 'JSONEachRow',
    });
    const data = await response?.json<T>();
    return data as T[];
  }

  private formatSqlType(value: any): string {
    // Catch any dates being passed in as a string


    if (typeof value === 'string' && (value.endsWith('(Coordinated Universal Time)') || /\.\d{3}Z$/.test(value))) {
      value = new Date(value);
    }
    if (value instanceof Date) return "parseDateTimeBestEffort('" + value.toISOString() + "')";
    if (typeof value === 'object') {
      if (Array.isArray(value)) return value.map(this.formatSqlType).join(',');
      if (value === null) return 'null';
      return JSON.stringify(value);
    }

    return value;
  }
}

const redisHelpers = (redis: IRedisClient) => {
  const scripts = {
    nxWithTtl: `
      if redis.call('SET', KEYS[1], ARGV[1], 'NX', 'KEEPTTL') then
        return redis.call('EXPIRE', KEYS[1], ARGV[2])
      else
        return 0
      end
    `,
    hIncrIfExists: `
      if redis.call('EXISTS', KEYS[1]) == 1 then
        return redis.call('HINCRBY', KEYS[1], ARGV[1], ARGV[2])
      else
        return 0
      end
    `,
    // Idempotent variant of hIncrIfExists. KEYS[2] is a per-event dedupe
    // marker; ARGV[3] is its TTL (seconds). The increment only runs the first
    // time a given event is seen, so a Kafka redelivery (rebalance/retry)
    // re-applying the same delta becomes a no-op — the Redis equivalent of the
    // ClickHouse ReplacingMergeTree dedup. The marker is set BEFORE the
    // existence check on KEYS[1], so an event that arrives while the metric key
    // is cold (not yet populated) still records "seen": if a reader populates
    // the key from ClickHouse (which already has this event's row) before the
    // redelivery lands, the redelivery won't double-count it.
    // KEYS[2] MUST be hash-tagged to KEYS[1]'s slot (e.g. {<KEYS[1]>}:...)
    // so both keys co-locate on one cluster node.
    hIncrIfExistsOnce: `
      if redis.call('SET', KEYS[2], '1', 'NX', 'EX', ARGV[3]) then
        if redis.call('EXISTS', KEYS[1]) == 1 then
          return redis.call('HINCRBY', KEYS[1], ARGV[1], ARGV[2])
        end
        return 0
      else
        return 0
      end
    `,
  };
  const scriptShas: Partial<Record<keyof typeof scripts, string>> = {};

  const loadScripts = async () => {
    for (const [name, script] of Object.entries(scripts)) {
      if ('masters' in (redis as any)) {
        const cluster = redis as any;
        const masters = cluster.masters ? Object.values(cluster.masters) : [];
        for (const master of masters as {client: IRedisClient}[]) {
          const sha = await master.client.sendCommand?.(['SCRIPT', 'LOAD', script.trim()]);
          if (sha) scriptShas[name as keyof typeof scripts] = sha;
        }
      } else {
        const sha = await redis.sendCommand?.(['SCRIPT', 'LOAD', script.trim()]);
        if (sha) scriptShas[name as keyof typeof scripts] = sha;
      }
    }
  }

  const addScripts = (redis: IRedisClient | IRedisMulti) => {
    const executeScript = async (name: keyof typeof scripts, keys: string[], args: string[]) => {
      const sha = scriptShas[name];
      if (!sha) return await redis.eval(scripts[name], { keys, arguments: args });
      else return redis.evalSha(sha, { keys, arguments: args });
    }

    return {
      async setNxKeepTtlWithEx(key: string, value: string, ttl: number) {
        const result = await executeScript('nxWithTtl', [key], [value, String(ttl)]);
        return result === 1;
      },
      async hIncrIfExists(key: string, field: string, incrBy = 1) {
        const result = await executeScript('hIncrIfExists', [key], [field, incrBy.toString()]);
        return result !== 0;
      },
      // Idempotent hIncrIfExists. `dedupeKey` must be hash-tagged to `key`'s
      // cluster slot. The increment runs once per unique dedupeKey within ttl
      // seconds; replays are no-ops. Returns false when the increment was
      // skipped (duplicate or cold key).
      async hIncrIfExistsOnce(key: string, dedupeKey: string, field: string, incrBy: number, ttl: number) {
        const result = await executeScript('hIncrIfExistsOnce', [key, dedupeKey], [field, incrBy.toString(), String(ttl)]);
        return result !== 0;
      },
    }
  }

  const helpers = {
    async hSetEx(key: string, fields: Record<string, string>, ttl: number) {
      return redis.multi().hSet(key, fields).expire(key, ttl).exec();
    },
    async run<T>(ops: Promise<T>[]) {
      return Promise.all(ops);
    },
    ...addScripts(redis),
  };

  return { ...helpers, loadScripts, addScripts };
};

export type RedisWithHelpers<TRedis extends IRedisClient = IRedisClient> = Omit<TRedis, 'multi'> &
  Omit<ReturnType<typeof redisHelpers>, 'addScripts'> & {
    multi: () => MultiWithHelpers<TRedis>;
  };

// Extract the return type of TRedis's multi method, or default to IRedisMulti
type ExtractMultiType<T> = T extends { multi(): infer M } ? M : IRedisMulti;

export type MultiWithHelpers<TRedis extends IRedisClient> = ExtractMultiType<TRedis> & ReturnType<ReturnType<typeof redisHelpers>['addScripts']>;

export function withRedisHelpers<TRedis extends IRedisClient>(redis: TRedis): RedisWithHelpers<TRedis> {
  const { addScripts, ...helpers } = redisHelpers(redis);

  return new Proxy(redis as unknown as RedisWithHelpers<TRedis>, {
    get(target, prop, receiver) {
      // Return helper functions if available
      if (prop in helpers) return (helpers as any)[prop];

      // Special handling for multi() to include all helpers in the pipeline
      if (prop === 'multi') {
        return (): MultiWithHelpers<TRedis> => {
          const multi = (target as any).multi() as ExtractMultiType<TRedis>;
          const scripts = addScripts(multi);

          // Create proxy for multi that includes all available multi helpers
          return new Proxy(multi, {
            get(multiTarget, multiProp) {
              // Check if this is a multi-compatible helper
              if (multiProp in scripts) return (scripts as any)[multiProp];

              // Return original multi methods
              const val = Reflect.get(multiTarget, multiProp);
              return typeof val === 'function' ? val.bind(multiTarget) : val;
            }
          }) as MultiWithHelpers<TRedis>;
        };
      }

      // Default behavior for other properties
      const val = Reflect.get(target as object, prop, receiver);
      if (typeof val === 'function') {
        if (logger.isDebugEnabled) {
          logger.redis(`Binding function: ${String(prop)}`);
        }
        return function(...args: any[]) {
          if (logger.isDebugEnabled) {
            logger.redis(`Calling ${String(prop)} with args:`, args.length);
          }
          try {
            return val.apply(target, args);
          } catch (error) {
            logger.error('withRedisHelpers', `Function ${String(prop)} threw error:`, error);
            throw error;
          }
        };
      }
      return val;
    },
  });
}
