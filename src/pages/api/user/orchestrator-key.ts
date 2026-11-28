import { assertAccountNotRestricted } from '~/server/services/account-restriction.service';
import { RESTRICTED_ACCOUNT_MESSAGE } from '~/server/common/content-restriction';
import { mintApiKey, pruneDocsApiKeys } from '~/server/services/api-key.service';
import { AuthedEndpoint, handleEndpointError } from '~/server/utils/endpoint-helpers';
import { isSessionOrAcceptedBearer } from '~/server/utils/require-full-scope-session';
import { refuseWhileImpersonating } from '~/server/auth/refuse-while-impersonating';
import { claimRateLimitAttempt } from '~/server/utils/rate-limit-bucket';
import {
  DOCS_API_KEY_BUZZ_LIMIT,
  DOCS_API_KEY_MAX_AGE_SECONDS,
  DOCS_API_KEY_SCOPE,
  docsApiKeyName,
} from '~/shared/constants/docs-api-key.constants';

/** The only page that asks for this key: the developer docs' "Try it" panels. */
const DOCS_ORIGIN = 'https://developer.civitai.com';

const RATE_LIMIT = { keyName: 'apiKey:docsKey', rules: [{ limit: 10, period: 60 * 60 }] };

/**
 * Mints a developer docs key for the signed-in user (docs-api-key.constants.ts). GET goes once the
 * docs call this with POST (civitai/civitai#10723).
 */
export default AuthedEndpoint(
  async function handler(req, res, user, session) {
    if (req.headers.origin !== DOCS_ORIGIN)
      return res.status(403).json({ error: 'This key is only issued to the developer docs' });
    // A browser session only: no personal key or app token, even a full-scope one.
    if (!isSessionOrAcceptedBearer(req, () => false))
      return res.status(403).json({ error: 'This action requires a signed-in session' });
    if (refuseWhileImpersonating(session, res, "API keys can't be created while impersonating"))
      return;
    if (req.method === 'POST') {
      const contentType = req.headers['content-type']?.split(';')[0].trim().toLowerCase();
      if (contentType !== 'application/json')
        return res.status(415).json({ error: 'Content-Type must be application/json' });
    }
    try {
      const host = req.headers.host?.toLowerCase().split(':')[0];
      if (!host) return res.status(400).json({ error: 'Missing host header' });

      const record = await claimRateLimitAttempt({ ...RATE_LIMIT, user, req });
      await record();
      await assertAccountNotRestricted(user.id);

      const name = docsApiKeyName(host);
      const date = new Date();
      await pruneDocsApiKeys({ userId: user.id, name, date });
      const key = await mintApiKey(
        {
          name,
          type: 'User',
          userId: user.id,
          tokenScope: DOCS_API_KEY_SCOPE,
          buzzLimit: DOCS_API_KEY_BUZZ_LIMIT,
          maxAge: DOCS_API_KEY_MAX_AGE_SECONDS,
        },
        { refusalMessage: RESTRICTED_ACCOUNT_MESSAGE, date }
      );
      const expiresAt = new Date(date.getTime() + DOCS_API_KEY_MAX_AGE_SECONDS * 1000);

      return res.status(200).json({ key, name, expiresAt: expiresAt.toISOString() });
    } catch (e) {
      return handleEndpointError(res, e);
    }
  },
  ['GET', 'POST']
);
