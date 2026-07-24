export interface IPgClient {
  query<R extends Record<string, any> = any, I = any[]>(
    queryTextOrConfig: string | { text: string; values?: I },
    values?: I
  ): Promise<{
    rows: R[];
    rowCount: number;
    command: string;
  }>;
}

/**
 * ResponseJSON type from ClickHouse client
 * Used for single-document JSON formats
 */
export interface ResponseJSON<T> {
  data: T[];
  meta?: Array<{ name: string; type: string }>;
  rows?: number;
  statistics?: {
    elapsed: number;
    rows_read: number;
    bytes_read: number;
  };
}

/**
 * ClickHouse client interface
 * Compatible with @clickhouse/client
 *
 * Note: The json<T>() return type is a union because it depends on the format parameter:
 * - JSONEachRow format: returns T[]
 * - JSON format: returns ResponseJSON<T>
 * - JSONObjectEachRow format: returns Record<string, T>
 */
export interface IClickhouseClient {
  query(params: {
    query: string;
    format?: string;
    clickhouse_settings?: Record<string, any>;
    query_params?: Record<string, unknown>;
    abort_signal?: AbortSignal;
    query_id?: string;
    session_id?: string;
  }): Promise<{
    json<T>(): Promise<T[] | Record<string, T> | ResponseJSON<T>>;
    text(): Promise<string>;
    stream(): any;
  }>;
}

// Define each command as [args, returnType]
// If a command has overloads, use a union of signatures
type RedisCommands = {
  hSet: [[key: string, field: string, value: string], number] | [[key: string, fields: Record<string, string>], number];

  hGet: [[key: string, field: string], string | null | undefined];
  hGetAll: [[key: string], Record<string, string>];
  hIncrBy: [[key: string, field: string, increment: number], number];
  expire: [[key: string, seconds: number], number];
  get: [[key: string], string | null];
  set: [[key: string, value: string, options?: { NX?: boolean; EX?: number }], string | null];
  del: [[keys: string | string[]], number];
  eval: [[script: string, options: { keys: string[]; arguments: string[] }], any];
  evalSha: [[sha: string, options: { keys: string[]; arguments: string[] }], any];
};

// Utility to map commands into client methods
type ToClient<T extends Record<string, any>> = {
  [K in keyof T]: T[K] extends [infer A, infer R]
    ? (...args: A extends any[] ? A : never) => Promise<R>
    : T[K] extends [infer A1, infer R1] | [infer A2, infer R2]
    ? ((...args: A1 extends any[] ? A1 : never) => Promise<R1>) & ((...args: A2 extends any[] ? A2 : never) => Promise<R2>)
    : never;
};

// Utility to map commands into multi methods
type ToMulti<T extends Record<string, any>> = {
  [K in keyof T]: T[K] extends [infer A, any]
    ? (...args: A extends any[] ? A : never) => IRedisMulti
    : T[K] extends [infer A1, any] | [infer A2, any]
    ? ((...args: A1 extends any[] ? A1 : never) => IRedisMulti) & ((...args: A2 extends any[] ? A2 : never) => IRedisMulti)
    : never;
};

export interface IRedisClient extends ToClient<RedisCommands> {
  multi(): IRedisMulti;
  sendCommand?(...args: any[]): any;
  // Packed methods for msgpackr serialization (from CustomRedisClient)
  // Optional - not all Redis clients provide packed methods
  packed?: {
    get<T>(key: string): Promise<T | null>;
    mGet<T>(keys: string[]): Promise<(T | null)[]>;
    set<T>(key: string, value: T, options?: { EX?: number }): Promise<void>;
    sAdd<T>(key: string, values: T[]): Promise<void>;
  };
}

export interface IRedisMulti extends ToMulti<RedisCommands> {
  exec(): Promise<any[]>;
}

// Data packer for binary serialization (e.g., msgpackr)
export interface IDataPacker {
  pack: (value: any) => Buffer;
  unpack: (packed: Buffer | Uint8Array) => any;
}

// Alias for PostgreSQL client
export type IDbClient = IPgClient;

