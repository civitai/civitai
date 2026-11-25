/**
 * The App Storage writes cutover, site side: whether an app's frame is told to send its document
 * store to the app-data service (`apps/app-data-go`), as `BLOCK_INIT.appData: { url, slug }`.
 *
 * The decision is made HERE, server-side, at the block token mint (`/api/v1/block-tokens`), and
 * travels to the run host in the mint's answer; the host forwards it and decides nothing about the
 * flag (`blockInitAppData` in `blockInitFragmentGate.ts`). The `appData` key is present only when
 * every one of these holds, and ABSENT otherwise:
 *  - the mint is a PRODUCTION page run: the page path (entity `none`) of an approved app, not a
 *    dev-tunnel preview. A dev-tunnel preview of an APPROVED app takes the same mint path as a
 *    production run and DOES reach this, marked only by the request's `devTunnel: true`, so the
 *    explicit `devTunnel` check below is what excludes it. The other dev-tunnel tokens (an
 *    ephemeral or owned non-approved app), the private-run token and the review-preview token come
 *    from other mint branches or endpoints, which never call this;
 *  - the token is a block token (an OAuth token is not served by the service);
 *  - `APP_DATA_SERVICE_PUBLIC_URL` is set to a plain https URL;
 *  - the app's blockId is a slug the service accepts;
 *  - the `app-data-writes-via-service` flag is on for the app (entity = the app block id).
 *
 * The flag is read last, so no other condition costs an evaluation.
 */
import { env } from '~/env/server';
import { isPlainHttpsUrl } from '~/env/plain-https-url';

/** `FLIPT_FEATURE_FLAGS.APP_DATA_WRITES_VIA_SERVICE`, spelled here so this module (imported by the
 *  token mint) loads the Flipt client only when it first reads the flag. */
export const APP_DATA_WRITES_VIA_SERVICE_FLAG = 'app-data-writes-via-service';

/** `BLOCK_INIT.appData`: the app-data service's base URL and the app's blockId. */
export type AppDataInit = { url: string; slug: string };

/** The service's slug grammar (an app's blockId), as the SDK checks it. */
export const APP_DATA_SLUG = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/;

export type AppDataInitInput = {
  /** The mint path: `none` is a full-page app, `model` a model-page slot. */
  entityType: 'model' | 'none';
  /** The request asked for a dev-tunnel token. */
  devTunnel: boolean;
  /** The kind of token this mint answers with. */
  tokenKind: 'block' | 'oauth';
  /** The app block id (`apb_…`): the flag's entity. */
  appBlockId: string;
  /** The app's blockId: the slug the service names it by. */
  blockId: string;
};

export type AppDataInitDeps = {
  /** `APP_DATA_SERVICE_PUBLIC_URL`, as the env parsed it. */
  url: () => string | undefined;
  /** The `app-data-writes-via-service` flag for one app. Never throws. */
  enabled: (appBlockId: string, blockId: string) => Promise<boolean>;
};

/**
 * The `appData` fragment of a mint's answer: `{ appData: { url, slug } }` when every condition in
 * this file's header holds, `{}` otherwise.
 */
export async function resolveAppDataInit(
  input: AppDataInitInput,
  deps: AppDataInitDeps = defaultDeps
): Promise<{ appData?: AppDataInit }> {
  if (input.entityType !== 'none' || input.devTunnel || input.tokenKind !== 'block') return {};
  const url = deps.url();
  if (url === undefined || !isPlainHttpsUrl(url)) return {};
  if (!APP_DATA_SLUG.test(input.blockId)) return {};
  if (!(await deps.enabled(input.appBlockId, input.blockId))) return {};
  return { appData: { url, slug: input.blockId } };
}

export type FlagReaders = {
  override: (flag: string) => string | undefined;
  read: (flag: string, entityId: string, context: Record<string, string>) => Promise<boolean>;
};

/**
 * The flag, FAIL-CLOSED and SILENT: a local override wins; otherwise `getFliptBoolean`, which
 * answers `false` for a missing key, an evaluation error or no client, without logging. Anything
 * that still throws reads as off.
 */
export async function isAppDataWritesViaServiceOn(
  appBlockId: string,
  blockId: string,
  readers?: FlagReaders
): Promise<boolean> {
  const flag = APP_DATA_WRITES_VIA_SERVICE_FLAG;
  try {
    const r = readers ?? (await fliptReaders());
    const override = r.override(flag);
    if (override !== undefined) return override === 'on';
    return (await r.read(flag, appBlockId, { blockId })) === true;
  } catch {
    return false;
  }
}

async function fliptReaders(): Promise<FlagReaders> {
  const { getFliptBoolean, getFliptLocalOverride } = await import('~/server/flipt/client');
  return { override: getFliptLocalOverride, read: getFliptBoolean };
}

const defaultDeps: AppDataInitDeps = {
  url: () => env.APP_DATA_SERVICE_PUBLIC_URL,
  enabled: (appBlockId, blockId) => isAppDataWritesViaServiceOn(appBlockId, blockId),
};
