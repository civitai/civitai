import { env } from '~/env/server';

/**
 * The roots whose one-label subdomains hold App Block frames, as this deployment sets
 * them: `APPS_DOMAIN` (published apps `<slug>.<root>` and dev tunnels `dev-<hex>.<root>`)
 * and, when set, `APP_ASSISTANT_PREVIEW_DOMAIN` (App Assistant direct-preview session
 * hosts). `_app` hands them to the client, where `isAppFrameHost`
 * (`~/components/AppBlocks/sandbox`) decides which frames may run at a real origin.
 * Review hosts live under `APPS_DOMAIN` too; the client refuses them by name and by
 * mount (`reviewMode`).
 */
export function getAppFrameDomains(): string[] {
  const out: string[] = [];
  for (const raw of [env.APPS_DOMAIN, env.APP_ASSISTANT_PREVIEW_DOMAIN]) {
    const root = raw?.trim().toLowerCase();
    if (root && !out.includes(root)) out.push(root);
  }
  return out;
}
