import { createJob } from './job';
import { dbWrite } from '~/server/db/client';
import { logToAxiom } from '~/server/logging/client';

/**
 * Garbage-collect stale Dynamically-Registered (RFC 7591) OAuth clients.
 *
 * Open registration means anyone can mint a client_id. To keep the table from
 * filling with abandoned/never-completed registrations, delete DCR clients that:
 *   - were created via /register (isDynamicallyRegistered = true), AND
 *   - have issued ZERO tokens, AND
 *   - have ZERO consents, AND
 *   - are older than 48 hours.
 *
 * A client that a user actually authorized (has a consent or a live token) is
 * never touched here — it's a real, in-use client. Cascade deletes handle any
 * orphaned rows, though by definition these have none.
 */
const STALE_HOURS = 48;

export const oauthDcrCleanup = createJob('oauth-dcr-cleanup', '15 * * * *', async () => {
  const cutoff = new Date(Date.now() - STALE_HOURS * 60 * 60 * 1000);

  const result = await dbWrite.oauthClient.deleteMany({
    where: {
      isDynamicallyRegistered: true,
      createdAt: { lt: cutoff },
      tokens: { none: {} },
      consents: { none: {} },
    },
  });

  if (result.count > 0) {
    logToAxiom({
      type: 'oauth-dcr-cleanup',
      deleted: result.count,
      olderThanHours: STALE_HOURS,
    });
  }

  return { deleted: result.count };
});
