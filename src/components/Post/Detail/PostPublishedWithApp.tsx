import { Anchor, Avatar, Badge, Text } from '@mantine/core';
import { AppListingCard } from '~/components/Apps/AppListingCard';
import { getListingDetailHref } from '~/components/Apps/appListingCardView';
import { NextLink as Link } from '~/components/NextLink/NextLink';
import { useFeatureFlags } from '~/providers/FeatureFlagsProvider';
import type { PostAppChip, PostAppChipItem } from '~/server/services/blocks/post-app-chip.logic';
import { trpc } from '~/utils/trpc';

/**
 * "Made with <app>" on the post and image detail pages: the app's store card under a small label.
 *
 * Posts created by an App Block carry the publishing app's id in
 * `Post.metadata.blockPublishedAppId`; the server resolves that marker into a {@link PostAppChip}
 * (`post-app-chip.logic.ts` has the disclosure constraints) and this component only renders it.
 * The chip says which app, the card comes from `appListings.getAppCard`, which applies the same
 * store visibility rules as the app's detail page.
 *
 * 🔴 "Made WITH", never "by". An approved block's `OauthClient.name` equals the app's own title,
 * so a "by {app}" line reads as the author. The author is a person; the app is a tool.
 * `PostPublishedWithApp.browser.test.tsx` pins the label as a whole string.
 *
 * Three states:
 *  - `app == null` renders nothing: no marker, a marker that resolves to no app, or a viewer
 *    without store visibility.
 *  - `app.slug == null` renders the name, unlinked: the app exists but the store would 404 it, so
 *    no card is fetched and no link is offered.
 *  - `app.slug != null` renders the card. While it loads, or if the card read fails, the linked
 *    name stands in, so the credit never disappears.
 *
 * The chip name arrives already sanitized (`sanitizeAppChromeName`); this component must not be
 * handed a raw name. The sanitizer bounds length and strips spoofing characters but does not stop
 * impersonation ("Civitai", "Official"), so this asserts which app wrote the post, not that the app
 * is who it says it is.
 */
export function PostPublishedWithApp({ app }: { app?: PostAppChip | null }) {
  if (!app) return null;

  return (
    <div className="flex min-w-0 flex-col gap-1" data-testid="post-published-with-app">
      {app.slug ? <LinkedApp app={app} slug={app.slug} /> : <AppName app={app} />}
    </div>
  );
}

/** "Made with" (+ "<item> on" when the post came from an app's sub-listing), as one string of text. */
function MadeWithLabel({ app }: { app: PostAppChip }) {
  return (
    <>
      Made with
      {app.item && (
        <>
          {' '}
          <ChipItemName item={app.item} /> on
        </>
      )}
    </>
  );
}

function LinkedApp({ app, slug }: { app: PostAppChip; slug: string }) {
  const features = useFeatureFlags();
  const { data: card } = trpc.appListings.getAppCard.useQuery(
    { slug },
    { retry: false, staleTime: 5 * 60 * 1000, refetchOnWindowFocus: false }
  );

  if (!card) return <AppName app={app} slug={slug} />;
  // The card sets its title in white, which only reads on a dark card; the store grid has the
  // same assumption. Scoping the dark scheme here keeps the title legible in the light theme.
  return (
    <div
      data-mantine-color-scheme="dark"
      className="w-full rounded-md"
      // `data-mantine-color-scheme` switches Mantine's variables but not CSS `light-dark()`, which
      // follows `color-scheme`: without this the title reads black on the card.
      style={{ colorScheme: 'dark' }}
    >
      <AppListingCard
        card={card}
        canOpenPage={features.appBlocksPages}
        embedded
        coverBadge={
          <Badge
            variant="filled"
            color="dark"
            size="md"
            radius="sm"
            tt="none"
            className="pointer-events-auto max-w-full"
            data-testid="post-published-with-app-label"
          >
            <MadeWithLabel app={app} />
          </Badge>
        }
      />
    </div>
  );
}

function AppName({ app, slug }: { app: PostAppChip; slug?: string }) {
  return (
    <div className="flex min-w-0 flex-col gap-1">
      <Text size="sm" c="dimmed" className="px-1">
        <MadeWithLabel app={app} />
      </Text>
      <AppNameRow app={app} slug={slug} />
    </div>
  );
}

function AppNameRow({ app, slug }: { app: PostAppChip; slug?: string }) {
  return (
    <div className="flex min-w-0 items-center gap-2 px-1">
      {app.iconUrl && (
        /* Decorative: the name beside it already says which app. */
        <Avatar src={app.iconUrl} alt="" radius="sm" size={20} style={{ flexShrink: 0 }} />
      )}
      <Text size="sm" className="min-w-0">
        {slug ? (
          <Anchor component={Link} href={getListingDetailHref(slug)} inherit>
            {app.name}
          </Anchor>
        ) : (
          app.name
        )}
      </Text>
    </div>
  );
}

function ChipItemName({ item }: { item: PostAppChipItem }) {
  if (!item.href) return <>{item.name}</>;
  if (item.external)
    return (
      <Anchor href={item.href} target="_blank" rel="noopener noreferrer" inherit>
        {item.name}
      </Anchor>
    );
  return (
    <Anchor component={Link} href={item.href} inherit>
      {item.name}
    </Anchor>
  );
}
