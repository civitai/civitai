/**
 * The identity headers every browser tRPC request carries (`~/utils/trpc` and
 * `~/utils/trpc-keepalive`). Kept in its own module so a client built outside `~/utils/trpc`
 * sends the same set without importing that module — component tests replace `~/utils/trpc`
 * wholesale, and a new named import from it fails to link wherever that is done.
 */
export type TrpcClientHeaders = {
  'x-client-date': string;
  'x-client': string;
  'x-client-version'?: string;
};

export const trpcClientHeaders: TrpcClientHeaders = {
  'x-client-version': process.env.version,
  'x-client-date': Date.now().toString(),
  'x-client': 'web',
};
