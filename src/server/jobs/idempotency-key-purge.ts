import { logToAxiom } from '~/server/logging/client';
import {
  isUndefinedTableError,
  purgeExpiredIdempotencyKeys,
} from '~/server/services/idempotency-key.service';
import { createJob } from './job';

/**
 * Deletes expired `IdempotencyKey` rows. Runs whatever the `idempotency-keys-pg` flag says, so rows
 * written while it was on are cleared after it is turned off. Before the hand-applied migration the
 * table does not exist: that run deletes nothing and succeeds.
 */
export const idempotencyKeyPurge = createJob('idempotency-key-purge', '37 4 * * *', async () => {
  try {
    return { deleted: await purgeExpiredIdempotencyKeys() };
  } catch (error) {
    if (!isUndefinedTableError(error)) throw error;
    logToAxiom({ name: 'idempotency-key-purge', type: 'info', message: 'table not applied yet' });
    return { deleted: 0, tableMissing: true };
  }
});
