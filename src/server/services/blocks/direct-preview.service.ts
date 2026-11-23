import { env } from '~/env/server';
import { FLIPT_FEATURE_FLAGS, isFlipt } from '~/server/flipt/client';
import { buildFliptContext } from '~/server/services/feature-flags.service';
import { logToAxiom } from '~/server/logging/client';
import {
  mintPreviewLabel,
  parsePreviewSigningKeyResult,
  type PreviewKey,
} from '~/server/services/blocks/preview-session-host';
import type { SessionUser } from '~/types/session';

/**
 * App Assistant direct preview: whether it is on for a user, and the session-host mint.
 *
 * ON only when ALL of these hold, and off (the dev tunnel, exactly as before) otherwise:
 *   - the `app-assistant-direct-preview` Flipt flag is on for the user (fails closed);
 *   - APP_ASSISTANT_PREVIEW_DOMAIN is set;
 *   - APP_ASSISTANT_PREVIEW_KEYS parses to a signing key: the preview gateway's own key-set value
 *     (`{current, previous?}`, minting with `current`) or a bare `{kid, key}`. A value that is set
 *     but does not parse is logged (once per value per process) and leaves the feature off;
 *   - PREVIEW_REVOKE_HMAC_SECRET is set, so an ended session can be revoked at the gateway.
 * A configuration gap turns the feature off rather than failing a preview.
 */

export type DirectPreviewConfig = { domain: string; key: PreviewKey };

/** The last unparseable key value logged, so a bad value is reported once, not on every open. */
let reportedBadKeys: string | undefined;

/** The deployment's direct-preview configuration, or null when any piece is missing. */
export function getDirectPreviewConfig(): DirectPreviewConfig | null {
  const domain = env.APP_ASSISTANT_PREVIEW_DOMAIN?.trim();
  if (!domain) return null;
  const raw = env.APP_ASSISTANT_PREVIEW_KEYS;
  const parsed = parsePreviewSigningKeyResult(raw);
  if (!parsed.ok) {
    if (parsed.reason === 'invalid' && raw !== reportedBadKeys) {
      reportedBadKeys = raw;
      // The reason names a field, never the value: the value is the signing key.
      logToAxiom({
        type: 'app-assistant.direct-preview.bad-keys',
        message: `APP_ASSISTANT_PREVIEW_KEYS does not parse (${parsed.error}); direct preview is off`,
      });
    }
    return null;
  }
  if (!env.PREVIEW_REVOKE_HMAC_SECRET?.trim()) return null;
  return { domain, key: parsed.key };
}

/** The direct-preview configuration when the flag is on for `user` too, else null. */
export async function getDirectPreviewConfigFor(
  user: SessionUser
): Promise<DirectPreviewConfig | null> {
  const config = getDirectPreviewConfig();
  if (!config) return null;
  const on = await isFlipt(
    FLIPT_FEATURE_FLAGS.APP_ASSISTANT_DIRECT_PREVIEW,
    String(user.id),
    buildFliptContext(user)
  );
  return on ? config : null;
}

/** The session host for one session: its label under the configured key, under the preview domain. */
export function mintPreviewSessionHost(
  config: DirectPreviewConfig,
  fields: { previewId: string; userId: number; exp: number }
): string {
  return `${mintPreviewLabel({ kid: config.key.kid, ...fields }, config.key.key)}.${config.domain}`;
}
