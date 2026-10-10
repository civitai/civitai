import { Anchor, Avatar, Text } from '@mantine/core';
import { getListingDetailHref } from '~/components/Apps/appListingCardView';
import { NextLink as Link } from '~/components/NextLink/NextLink';
import type { PostAppChip } from '~/server/services/blocks/post-app-chip.logic';

/**
 * The post-detail "Published with <app>" attribution chip.
 *
 * Posts created by an App Block carry the publishing app's id in
 * `Post.metadata.blockPublishedAppId`; nothing read it, so a viewer could not
 * tell an app-published post from a hand-made one. The server resolves that
 * marker into a {@link PostAppChip} (`post-app-chip.ts` — read its header for
 * the disclosure constraints); this component is only the rendering.
 *
 * ## 🔴 "Published WITH", never "by". The wording is the point.
 *
 * `public-owner.ts` exists *because* the app page rendered `by {appName}` and,
 * since an approved block's `OauthClient.name` equals the app's own title, the
 * AUTHOR slot showed the APP TITLE. The author is a person; the app is a tool.
 * This chip sits in the post header near real author attribution, so the
 * distinction has to survive future edits — `PostPublishedWithApp.browser.test.tsx`
 * pins the rendered sentence as a WHOLE normalised string, so a reword that
 * reintroduces "by" fails rather than quietly shipping.
 *
 * ## Three states, all reachable in production
 *
 *  - `app == null` → renders NOTHING. Covers a post with no marker, a marker
 *    that resolves to no app (the dev-mint path writes a deliberately
 *    non-resolving id), and a viewer without store visibility.
 *  - `app.slug == null` → the name, UNLINKED. The app exists but the store's own
 *    read would refuse it (not approved, never deployed, or mature on a non-red
 *    host), so `/apps/store-preview/<slug>` would 404. A link to a 404 is worse
 *    than plain text. The server withholds the icon on this branch too — see
 *    `projectPostAppChip` for why that is deliberate.
 *  - `app.slug != null` → the name, linked to the store detail.
 *
 * `iconUrl` is independently nullable and commonly null — a live app has none —
 * so the `Avatar` is rendered only when there is something to show. ⚠️ The three
 * existing listing surfaces (`AppListingCard`, and the two chrome sites) do the
 * opposite: they keep the `Avatar` and let it fall back to a SEEDED MONOGRAM
 * (per-app hue + initial), not Mantine's flat grey. That is right for a grid
 * card, where the icon is the only identifier and a gap would break the row.
 * Here the sentence immediately beside it names the app in full, so a 16 px
 * monogram would restate the initial of a word already on screen. Omitting is a
 * deliberate divergence from those three, for that reason.
 *
 * The name arrives ALREADY SANITIZED (`sanitizeAppChromeName`, applied in the
 * server projector) because it is publisher-controlled. This component does not
 * sanitize and must not be handed a raw name. ⚠️ That sanitizer bounds LENGTH and
 * strips the mechanical spoofing vectors; it deliberately does NOT defend against
 * name-based IMPERSONATION ("Civitai", "Official", homoglyphs), which needs a
 * verified-publisher signal and is tracked separately. So this chip asserts which
 * app wrote the post, not that the app is who it says it is.
 */
export function PostPublishedWithApp({ app }: { app?: PostAppChip | null }) {
  if (!app) return null;

  return (
    <div
      // `min-w-0` so the sanitizer's 64-code-point ceiling cannot push the header
      // row wider than its container on a narrow viewport; the text wraps inside
      // the chip instead.
      className="flex min-w-0 items-center gap-1"
      data-testid="post-published-with-app"
    >
      {app.iconUrl && (
        /* Decorative: the sentence beside it already names the app, so a second
           accessible name here would make a screen reader say it twice. */
        <Avatar src={app.iconUrl} alt="" radius="sm" size={16} style={{ flexShrink: 0 }} />
      )}
      <Text size="xs" c="dimmed" className="min-w-0">
        Published with{' '}
        {app.slug ? (
          <Anchor component={Link} href={getListingDetailHref(app.slug)} inherit>
            {app.name}
          </Anchor>
        ) : (
          app.name
        )}
      </Text>
    </div>
  );
}
