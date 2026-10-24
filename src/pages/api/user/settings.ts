import { PublicEndpoint } from '~/server/utils/endpoint-helpers';
import { resolveSettingsBootstrap } from '~/server/services/settings-bootstrap.service';

/**
 * The settings bootstrap over HTTP. A server render reads the same function in-process
 * (`resolveSettingsBootstrapForRender`), so everything about WHAT is returned lives in
 * `settings-bootstrap.service` — this route only puts it on the wire.
 */
export default PublicEndpoint(
  async function handler(req, res) {
    try {
      res.status(200).json(await resolveSettingsBootstrap({ req, res }));
    } catch (e) {
      // No `session` key: a caller must read this as "bootstrap failed", never "signed out".
      res.status(200).json({});
    }
  },
  ['GET']
);
