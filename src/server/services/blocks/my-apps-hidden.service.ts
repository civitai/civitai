import { logToAxiom } from '~/server/logging/client';
import { getUserSettings, patchUserSettings } from '~/server/services/user.service';
import {
  HIDDEN_APPS_MAX,
  HIDDEN_APPS_SETTINGS_KEY,
  hiddenAppsOverflow,
  openingClearsHide,
  sanitizeHiddenApps,
  type HiddenApps,
} from '~/shared/utils/my-apps-hidden';

/**
 * "Remove from My apps" — the writes and the read behind `appListings.hideMyApp`,
 * `unhideMyApp` and the `hidden` half of `listMyApps`. The rules (what a hide means, when the
 * app comes back) are in `~/shared/utils/my-apps-hidden.ts`.
 *
 * STORAGE: `User.settings.hiddenApps` (`{ [slug]: ISO time }`) — the existing JSON column,
 * no migration. Every write goes through `patchUserSettings`, which compiles to ONE
 * `UPDATE … SET settings = <expression over the current column>`: the hide is a `mergeInto`
 * of a single slug and the unhide a `removeFrom` of a single slug, so neither reads the blob
 * into JS and neither can clobber a concurrent write to another settings key, or to another
 * slug under `hiddenApps`.
 *
 * THE CAP is applied after the hide, from the row the hide RETURNED: when it holds more than
 * `HIDDEN_APPS_MAX` slugs, the oldest are removed with a second `removeFrom`. That second
 * statement names exact slugs, so a concurrent hide of a different slug survives it; the
 * only race is two overflowing hides each trimming, which can at worst trim a few more of the
 * oldest entries — they simply show again.
 *
 * The listing behind a slug is deliberately NOT looked up: hiding is a preference about the
 * viewer's own home, a slug that matches nothing is inert (and bounded by the cap), and a
 * lookup would turn the mutation into an oracle for which slugs exist.
 */

export async function hideMyApp(args: {
  userId: number;
  slug: string;
  now?: Date;
}): Promise<{ slug: string; hiddenAt: string }> {
  const hiddenAt = (args.now ?? new Date()).toISOString();
  const settings = await patchUserSettings(args.userId, {
    mergeInto: { [HIDDEN_APPS_SETTINGS_KEY]: { [args.slug]: hiddenAt } },
    location: 'my-apps:hide',
  });
  const overflow = hiddenAppsOverflow(
    (settings as Record<string, unknown>)[HIDDEN_APPS_SETTINGS_KEY],
    HIDDEN_APPS_MAX
  );
  if (overflow.length) {
    await patchUserSettings(args.userId, {
      removeFrom: { [HIDDEN_APPS_SETTINGS_KEY]: overflow },
      location: 'my-apps:hide-cap',
    });
  }
  return { slug: args.slug, hiddenAt };
}

export async function unhideMyApp(args: { userId: number; slug: string }): Promise<{
  slug: string;
}> {
  await patchUserSettings(args.userId, {
    removeFrom: { [HIDDEN_APPS_SETTINGS_KEY]: [args.slug] },
    location: 'my-apps:unhide',
  });
  return { slug: args.slug };
}

/** The viewer's hides, narrowed to well-formed entries. Read-only: never written back. */
export async function getMyHiddenApps(userId: number): Promise<HiddenApps> {
  const settings = await getUserSettings(userId);
  return sanitizeHiddenApps((settings as Record<string, unknown>)[HIDDEN_APPS_SETTINGS_KEY]);
}

/**
 * The run page's READ for "opening clears the hide" (`openingClearsHide`): is `slug` in the
 * viewer's hides? Read from the same cached settings as `getMyHiddenApps`, and FAILS OPEN to
 * `false` on any error — it sits on the app-launch path, where a throw would take the app
 * away. A false negative leaves the hide in place, so `listMyApps` keeps dropping the row; the
 * app still shows on this browser's home, as a recents-only tile (the run page records the
 * open). The WRITE is the client's `unhideMyApp` call after mount, only when this is true.
 */
export async function isMyAppHidden(args: { userId: number; slug: string }): Promise<boolean> {
  try {
    return openingClearsHide(await getMyHiddenApps(args.userId), args.slug);
  } catch (err) {
    // Logged, not swallowed; the `.catch` keeps a failed log off `unhandledRejection`.
    logToAxiom({
      name: 'my-apps-hidden-read-degraded',
      type: 'error',
      message: err instanceof Error ? err.message : String(err),
    }).catch(() => null);
    return false;
  }
}
