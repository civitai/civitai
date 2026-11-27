// Likeness-request marks that never landed. Without the mark, the appeal-decision-records sweep keeps
// the image's appeal training copies until their retention ends, so any increase needs a manual
// re-mark. Imported from `@civitai/telemetry/client` directly so the moderator service does not pull
// `~/server/prom/client`'s pool gauges.
import { registerCounter } from '@civitai/telemetry/client';

export const likenessRequestMarkFailedCounter = registerCounter({
  name: 'likeness_request_mark_failed_total',
  help: 'Removals on a likeness request whose likenessRequest ModActivity insert still failed after its retries. Each one leaves the appeal training copies of the removed images in place.',
});
