import {
  Button,
  Divider,
  Group,
  Loader,
  Popover,
  Stack,
  Text,
  UnstyledButton,
} from '@mantine/core';
import { IconBuildingStore } from '@tabler/icons-react';
import { getListingDetailHref, getRecommendLabel } from '~/components/Apps/appListingCardView';
import { NextLink as Link } from '~/components/NextLink/NextLink';
import { useOptionalFeatureFlags } from '~/providers/FeatureFlagsProvider';
import type { ListingDetail } from '~/server/schema/blocks/app-listing-read.schema';
import { hasAppsStoreAccess } from '~/shared/utils/app-blocks-access';
import { trpc } from '~/utils/trpc';
import { useIframeAwareMenu } from './useIframeAwareMenu';

/**
 * The trailing crumb of the app-block host chrome's breadcrumb (`Marketplace /
 * <app name>`) — the app's own name, and the one place in the frame where the
 * running app is named on the page surface.
 *
 * It used to be a static `<Text>`. It is now a real CONTROL: a button that opens a
 * popover carrying the app's FULL name (the crumb itself is width-capped and
 * ellipsised, so a long name is unreadable in the bar), the store's recommend
 * rollup, and a "View in App Store" action. The crumb was already the most
 * name-shaped thing in the chrome, so it is where a user looks to ask "what IS
 * this app?"; before this it answered nothing.
 *
 * 🔴 THE WHOLE CLUSTER IS GATED ON `hasAppsStoreAccess`, AND THE GATE IS THE SAME
 * ONE THE STORE ITSELF USES. Both halves of what the popover offers are refused by
 * the server for a viewer outside that predicate: `/apps/store-preview/<slug>`
 * `getServerSideProps`-gates on it (via `resolveAppsPageAccess`) and returns
 * `notFound`, and `appListings.getAppDetail` resolves a `StoreVisibilityScope` of
 * `none` and throws NOT_FOUND. So for an ineligible viewer the trigger would be an
 * affordance leading to a 404 and a rating that can never load. Such a viewer gets
 * the PRE-CHANGE static `<Text>` back, byte-for-byte — not a disabled button, not
 * an empty popover.
 *
 * 🔴 IT READS THE FLAGS THROUGH `useOptionalFeatureFlags`, NOT `useFeatureFlags`,
 * AND THAT IS A FAIL-CLOSED DECISION RATHER THAN A CONVENIENCE. `useFeatureFlags`
 * THROWS outside its provider. This crumb renders inside `AppBlockChrome`, which is
 * mounted from three hosts and is deliberately renderable in isolation; making it
 * throw would turn "flags are unavailable here" into a crashed chrome on a surface
 * that has nothing to do with the store. The optional hook returns `null` there,
 * and `hasAppsStoreAccess(null)` is `false` — so the absence of flags removes the
 * affordance instead of granting it. In the app itself the provider is always
 * present (`BaseLayout` wraps every page), so production reads the real flags.
 *
 * 🔴 THE POPOVER IS ON `useIframeAwareMenu`, LIKE EVERY OTHER FLOATING SURFACE IN
 * THIS CHROME. The chrome sits directly on top of a cross-origin app iframe, which
 * swallows the `mousedown` of a click into the app, so Mantine's
 * `closeOnClickOutside` never fires and an uncontrolled dropdown is left hanging
 * over the app the user just clicked into. That is not an edge case — clicking into
 * the app is the single most likely next action on this surface. The hook supplies
 * controlled open state plus the one signal that DOES fire (window `blur`). This is
 * the third site to need it and the second time it would have been born wrong: the
 * ⋮ overflow menu shipped without it for exactly this reason. The ledger in
 * `__tests__/iframeAwareMenu.test.ts` now counts `<Popover>` as well as `<Menu>`,
 * here as well as in the chrome, so a fourth floating surface cannot be added
 * without wiring it.
 *
 * 🔴 A CONTROLLED `Popover.Target` GETS NO `onClick` FROM MANTINE — the toggle
 * below is REQUIRED, not belt-and-braces. `PopoverTarget` clones its child with
 * `...(!ctx.controlled ? { onClick: ctx.onToggle } : null)`
 * (@mantine/core 7.17.8, `Popover/PopoverTarget/PopoverTarget.mjs`), so passing
 * `opened` — which is what putting it on the hook does — silently removes the
 * click handler Mantine would otherwise attach. Dropping our own `onClick` leaves a
 * button that looks right, carries every ARIA attribute, and opens nothing.
 */
export function AppNameCrumb({
  name,
  slug,
  maxWidth,
}: {
  /**
   * The app's display name, ALREADY SANITIZED by the caller
   * (`sanitizeAppChromeName` — strips bidi overrides, zero-width/control chars,
   * caps combining runs, bounds length). It is publisher-controlled, so it must
   * never arrive here raw; this component re-renders it in two places (the crumb
   * and the popover heading) and sanitizes in neither.
   */
  name: string;
  /**
   * The app's store slug. For an on-site app this is the `AppBlock.block_id` — the
   * SAME string the `/apps/run/<slug>` route resolves and the SAME one
   * `AppListing.slug` holds (`app-listing-mapper.ts` writes `slug: ab.blockId`), so
   * one value keys both the run route and the store. Omitted → no store cluster (a
   * caller that has not threaded it gets the static crumb, not a broken link).
   */
  slug?: string;
  /**
   * The responsive `max-width` for the crumb, resolved by `chromeGeometry.ts` from
   * the bar's own measured inline size. Threaded through unchanged so the control
   * truncates at exactly the width the static text did — `undefined` means UNCAPPED
   * (the `xl` tier).
   */
  maxWidth: number | undefined;
}) {
  const features = useOptionalFeatureFlags();
  const canSeeStore = hasAppsStoreAccess(features);
  const popover = useIframeAwareMenu();

  // The crumb's visual contract, IDENTICAL in both branches. `truncate` +
  // `maw` are what keep a long publisher name from shoving the ⋮ menu off the
  // row; the control must not be the one place that forgets them.
  const crumbText = (
    <Text size="xs" c="dimmed" fw={500} truncate maw={maxWidth} span>
      {name}
    </Text>
  );

  // Ineligible viewer (or no slug threaded): the pre-change static crumb, with the
  // same testid so nothing downstream has to branch on the gate.
  if (!canSeeStore || !slug) {
    return (
      <Text
        size="xs"
        c="dimmed"
        fw={500}
        truncate
        maw={maxWidth}
        data-testid="app-block-breadcrumb-name"
      >
        {name}
      </Text>
    );
  }

  return (
    <Popover
      width={260}
      position="bottom-start"
      shadow="md"
      withArrow
      opened={popover.opened}
      onChange={popover.onChange}
    >
      <Popover.Target>
        {/* `UnstyledButton` renders a real `<button type="button">` with Mantine's
            `focusable` styles applied, so the control is keyboard-operable (Enter /
            Space fire `click` natively) and carries a VISIBLE focus ring via the
            `mantine-focus-auto` class rather than a suppressed outline. A `div` with
            an `onClick` — the shape this deliberately is not — would have neither.
            `Popover.Target` adds `aria-haspopup="dialog"`, `aria-expanded` and
            `aria-controls` on top (`withRoles` is on by default). */}
        <UnstyledButton
          data-testid="app-block-breadcrumb-name"
          // See the 🔴 note in the component header: a CONTROLLED Popover.Target is
          // cloned WITHOUT Mantine's own onClick, so this is the only thing that
          // opens the popover.
          onClick={() => popover.onChange(!popover.opened)}
          style={{
            // The crumb is a flex item in a `nowrap` row that must stay one line
            // (`CHROME_BAR_PX`); `minWidth: 0` lets the truncating child actually
            // shrink instead of forcing the row wider.
            minWidth: 0,
            display: 'inline-flex',
            alignItems: 'center',
            cursor: 'pointer',
          }}
        >
          {crumbText}
        </UnstyledButton>
      </Popover.Target>
      <Popover.Dropdown data-testid="app-block-name-popover">
        {/* Mantine mounts a dropdown's children only while it is OPEN (`keepMounted`
            is off by default), so putting the query inside this child is what makes
            the fetch lazy — STRUCTURALLY, not via an `enabled` flag that has to be
            kept correct. See the card's own header for why that distinction earned
            its own component. */}
        <AppNameCrumbCard name={name} slug={slug} />
      </Popover.Dropdown>
    </Popover>
  );
}

/**
 * The popover's body: the app's full name plus whatever the STORE knows about it.
 *
 * 🔴 A SEPARATE COMPONENT BECAUSE THE tRPC HOOK MUST NOT RUN FOR EVERY CHROME. The
 * query used to live in `AppNameCrumb` with `enabled: canSeeStore && !!slug &&
 * opened`. That reads as equivalent and is not: the rules of hooks make the CALL
 * unconditional, so merely rendering the chrome instantiated a tRPC hook on every
 * page-surface mount — including for a viewer the gate had already excluded, and
 * including in any context without a full tRPC client. It was not theoretical:
 * `AppBlockChromePlatformNav.browser.test.tsx` mocks `~/utils/trpc` with only the
 * `blocks.*` procedures it needs, so `trpc.appListings` was `undefined` and all six
 * of its tests died with `Cannot read properties of undefined (reading
 * 'getAppDetail')` — surfacing as six identical 15-second timeouts, which is the
 * shape of a load flake rather than of a defect.
 *
 * Moving the hook behind the dropdown makes the gate real: an ineligible viewer
 * never instantiates it, and a closed popover never fetches. `enabled` is gone,
 * so there is no flag left to get wrong.
 */
function AppNameCrumbCard({ name, slug }: { name: string; slug: string }) {
  // `retry: false` matches `/apps/store-preview/<slug>`'s own call — a listing that
  // is missing, unapproved or scope-gated 404s server-side and should settle into
  // the unavailable state rather than being retried three times. React Query caches
  // the result, so re-opening the popover is instant.
  const { data, isLoading, error } = trpc.appListings.getAppDetail.useQuery(
    { slug },
    { retry: false }
  );
  const detail = data as ListingDetail | undefined;

  return (
    <Stack gap={6}>
      {/* The FULL name — the reason the popover is worth opening at all. No
          `truncate` and no `maw` here: the crumb is capped, this is not. */}
      <Text size="sm" fw={600} data-testid="app-block-name-popover-name">
        {name}
      </Text>
      <Divider />
      {isLoading ? (
        // Never render a rating slot that is empty or half known — a
        // "0% recommend" flashed while the query is in flight is a false
        // statement about the app, not a loading state.
        <Group gap={6} data-testid="app-block-name-popover-loading">
          <Loader size="xs" />
          <Text size="xs" c="dimmed">
            Loading store details…
          </Text>
        </Group>
      ) : error || !detail ? (
        // A valid slug can still 404 here — the listing may never have been minted,
        // may be unapproved, or may be scope/deploy/maturity-gated. All of those
        // mean the STORE has nothing to show, and the store PAGE would 404 the same
        // way, so the action is withheld with it. Suppressing the CTA on this branch
        // is the point: an "unavailable" note plus a link into a 404 would be worse
        // than either alone.
        <Text size="xs" c="dimmed" data-testid="app-block-name-popover-unavailable">
          Store details unavailable.
        </Text>
      ) : (
        <>
          {/* The SHARED formatter the store cards use — `getRecommendLabel` renders
              "No reviews yet" when `recommendPct` is null rather than a misleading
              "0% recommend". Reusing it is what keeps the frame and the store from
              disagreeing about the same app's rating. */}
          <Text size="xs" c="dimmed" data-testid="app-block-name-popover-recommend">
            {getRecommendLabel(detail.recommend, detail.reviewCount)}
          </Text>
          <Button
            component={Link}
            href={getListingDetailHref(detail.slug)}
            size="xs"
            variant="light"
            leftSection={<IconBuildingStore size={14} stroke={1.5} />}
            data-testid="app-block-name-popover-store-link"
          >
            View in App Store
          </Button>
        </>
      )}
    </Stack>
  );
}
