// App shim for @civitai/db helpers. Re-exports the pure utils + pool factory from the
// package, and binds the app's dbWrite into the Prisma-dependent helpers so existing
// call sites (getCurrentLSN(), checkNotUpToDate(lsn), dbKV) keep their signatures.
export * from '@civitai/db/db-helpers';

import {
  getCurrentLSN as _getCurrentLSN,
  checkNotUpToDate as _checkNotUpToDate,
  makeDbKV,
} from '@civitai/db/kv-helpers';
import { dbWrite } from '~/server/db/client';

export const getCurrentLSN = () => _getCurrentLSN(dbWrite);
export const checkNotUpToDate = (lsn: string) => _checkNotUpToDate(dbWrite, lsn);
export const dbKV = makeDbKV(dbWrite);
