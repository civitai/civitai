import { Anchor, Avatar, Text } from '@mantine/core';
import { getListingDetailHref } from '~/components/Apps/appListingCardView';
import { NextLink as Link } from '~/components/NextLink/NextLink';
import type { PostAppChip } from '~/server/services/blocks/post-app-chip';

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
 *  - `app.slug == null` → the name, UNLINKED. The app exists but its listing or
 *    its block is not approved, so `/apps/store-preview/<slug>` would refuse to
 *    serve it. A link to a 404 is worse than plain text.
 *  - `app.slug != null` → the name, linked to the store detail.
 *
 * `iconUrl` is independently nullable and commonly null (a live app has no
 * icon), so the `Avatar` is rendered only when there is something to show —
 * never as a grey placeholder box, which would read as a broken image.
 *
 * The name arrives ALREADY SANITIZED (`sanitizeAppChromeName`, applied in the
 * server projector) because it is publisher-controlled. This component does not
 * sanitize and must not be handed a raw name.
 */
export function PostPublishedWithApp({ app }: { app?: PostAppChip | null }) {
  if (!app) return null;

  return (
    <div className="flex items-center gap-1" data-testid="post-published-with-app">
      {app.iconUrl && (
        /* Decorative: the sentence beside it already names the app, so a second
           accessible name here would make a screen reader say it twice. */
        <Avatar src={app.iconUrl} alt="" radius="sm" size={16} style={{ flexShrink: 0 }} />
      )}
      <Text size="xs" c="dimmed">
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
