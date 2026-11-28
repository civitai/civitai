import { env } from '~/env/server';
import type { AppFrameDomains } from '~/shared/constants/app-frame-hosts.constants';

/**
 * The roots App Block frames live under, as this deployment sets them: `APPS_DOMAIN`
 * (published apps `<blockId>.<root>`, dev tunnels `dev-<16 hex>.<root>`, review hosts) and,
 * when set, `APP_ASSISTANT_PREVIEW_DOMAIN` (App Assistant preview session hosts). `_app`
 * hands them to the client, where `isAppFrameHost` (`~/components/AppBlocks/sandbox`)
 * decides which frames may run at a real origin. Both are visible to the browser anyway:
 * every frame's `src` is under one of them.
 */
export function getAppFrameDomains(): AppFrameDomains {
  const clean = (raw: string | undefined) => raw?.trim().toLowerCase() || null;
  return {
    appsDomain: clean(env.APPS_DOMAIN),
    previewDomain: clean(env.APP_ASSISTANT_PREVIEW_DOMAIN),
  };
}
