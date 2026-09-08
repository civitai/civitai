import { Alert, Button, Collapse, Divider, Group, Stack, Text, Title } from '@mantine/core';
import { useDisclosure } from '@mantine/hooks';
import {
  IconArrowRight,
  IconBrandDiscord,
  IconChevronDown,
  IconPlus,
  IconTerminal2,
} from '@tabler/icons-react';
import Link from 'next/link';
import { useCallback, useEffect, useRef } from 'react';
import {
  APPS_REQUEST_ACCESS_HREF,
  CLI_CREATE_SAMPLE_COMMAND,
  CLI_INSTALL_NPM,
  CLI_RUN_COMMAND,
} from '~/components/Apps/cliCommands';
import { AppsBuildBodySkeleton } from '~/components/Apps/AppsBuildBodySkeleton';
import { CopyableCommand } from '~/components/Apps/CopyableCommand';
import { EMBEDDED_KIND_LABEL, STANDALONE_KIND_LABEL } from '~/components/Apps/listingKindLabels';
import { GetStartedBody } from '~/components/Apps/GetStartedBody';
import { MyAppsBody } from '~/components/Apps/MyAppsBody';
import { resolveAppsBuildState, type AppsBuildState } from '~/components/Apps/appsBuildState';
import { useTrackEvent } from '~/components/TrackView/track.utils';
import { useCurrentUser } from '~/hooks/useCurrentUser';
import { useFeatureFlags } from '~/providers/FeatureFlagsProvider';
import { useIsClient } from '~/providers/IsClientProvider';
import { isAppDeveloper } from '~/shared/utils/app-blocks-access';
import { trpc } from '~/utils/trpc';

/** Where both "start an app" affordances go. `/apps/submit` keeps its route. */
const CREATE_FLOW_HREF = '/apps/submit';

/**
 * The consolidated `/apps/build` body — three states behind one route.
 *
 * This replaces THREE sub-nav items and two of their pages. `/apps/get-started` was 100%
 * static marketing with every CTA pointing off-platform and no in-product next step;
 * `/apps/submit`'s on-platform branch was the same copy-paste wall again; `/apps/mine`
 * was the only one of the three doing real work. A developer's path through them was
 * three tabs that mostly showed each other's content. See `./appsBuildState` for the
 * state machine and why `hasSubmissions` is part of the workbench test.
 *
 * 🔴 THE PAGE DOES NOT DECIDE ITS OWN ACCESS — `canAccessAppsBuild` does, and the `Build`
 * row in `SUB_NAV_LINKS` calls the same function. Do not add a flag check in here; a
 * second gate is how the tab and the page start disagreeing again (PR #4668).
 *
 * 🔴 THE B↔C SPLIT IS DEFERRED BEHIND `useIsClient()`, THE A↔BC SPLIT IS NOT, and the
 * asymmetry is the whole hydration story. `isAuthor` is SSR-frozen (see
 * `canAccessAppsBuild`'s note: neither `appBlocksAuthor` nor `appBlocksGetStarted`
 * declares `toggleable: true`, so the client overlay cannot move them), so applying it
 * to the first paint is safe and REQUIRED — deferring it would render the pitch to an
 * author for one frame. `blocks.getNavSummary` is genuinely client-only (tRPC runs
 * `ssr: false`), so its two booleans are absent on the server render; using them
 * un-deferred is the tab-set hydration mismatch (#418/#425) that bailed hydration of the
 * entire `/apps` root once already.
 *
 * 🔴 SO AN AUTHOR'S FIRST PAINT IS A SKELETON, NOT A STATE — AND THAT SENTENCE IS THE FIX.
 * This paragraph used to end "an author renders `first-app` on the server and on the first
 * client paint, and settles to `workbench` after mount if they have anything", which was an
 * accurate description of a BUG: `resolveAppsBuildState` reads an unresolved summary
 * (all-false) as `first-app`, so every author who HAS apps was shown "Ship your first app"
 * and then swapped. The deferral above is still exactly right — the summary genuinely
 * cannot be known on the server — but the answer to "what do we render while we do not
 * know" is `AppsBuildBodySkeleton`, not a guess. Server and first client paint are still
 * byte-identical, which is all hydration asks; they are now identical to each OTHER and to
 * nothing the viewer will be told is their state.
 */
export function AppsBuildBody() {
  const currentUser = useCurrentUser();
  const features = useFeatureFlags();
  const isClient = useIsClient();
  const { trackAction } = useTrackEvent();

  const isAuthor = currentUser
    ? isAppDeveloper(currentUser, { appBlocksAuthor: features.appBlocksAuthor })
    : false;

  // 🔴 THE `enabled` GATE MIRRORS THE PROCEDURE, NOT THE PAGE — the same rule `AppsSubNav`
  // documents. `blocks.getNavSummary` is `protectedProcedure.use(enforceAppBlocksFlag)`,
  // so without `appBlocks` or without a session it short-circuits to an all-false summary
  // having read nothing; asking anyway would buy a guaranteed round-trip to a guaranteed
  // answer. All-false is also the CORRECT summary for such a viewer: the workbench they
  // would resolve to reads `appListings.listMine`, and its Withdraw action carries
  // `enforceAppBlocksFlag` too.
  // 🔴 HOISTED OUT OF THE OPTIONS OBJECT SO THE WAIT CAN READ IT, AND THAT IS THE WHOLE
  // REASON IT IS A NAMED CONST. `isFetched` NEVER goes true for a query that never ran, so
  // "wait until fetched" would wait FOREVER for a viewer whose `enabled` is false — see
  // `settled` below, where that would have been a permanent skeleton.
  const summaryEnabled = !!features.appBlocks && !!currentUser && isAuthor;

  const { data: summary, isFetched } = trpc.blocks.getNavSummary.useQuery(undefined, {
    enabled: summaryEnabled,
    staleTime: 60_000,
  });

  const resolved = isClient ? summary : undefined;
  const state = resolveAppsBuildState({
    isAuthor,
    hasEditableApps: !!resolved?.hasEditableApps,
    hasSubmissions: !!resolved?.hasSubmissions,
  });

  const track = useCallback(
    (action: 'view' | 'request_access' | 'cli_copy' | 'create_entry', forState: AppsBuildState) => {
      trackAction({ type: 'AppsBuild_Action', details: { action, state: forState } }).catch(
        () => undefined
      );
    },
    [trackAction]
  );

  // 🔴 ONE `view` PER SETTLED STATE, NOT ONE PER RENDER AND NOT ONE PER STATE. The state
  // legitimately moves once — `first-app` → `workbench` — when `getNavSummary` lands after
  // mount, and firing on every distinct value would post TWO views for one visit by every
  // author who has apps, inflating the pitch→workbench denominator with a phantom
  // "first-app" that no human ever saw. So this fires exactly once per mount, and it waits
  // for the state to be SETTLED.
  //
  // 🔴 `isFetched`, NOT `summary !== undefined`, AND THE DIFFERENCE IS A WHOLE COHORT.
  // `isFetched` goes true on success OR error; `data` stays `undefined` forever on an
  // error. Keyed on the data, an author whose `getNavSummary` call FAILS is never settled
  // and posts no `view` at all — so the funnel's denominator silently excludes exactly the
  // people having a bad time, and the ratio it reports is biased upward by an amount
  // nothing in the data reveals. They are also the population most worth seeing. (This
  // paragraph is the correction to a comment that already claimed "resolves or errors"
  // while the code only handled "resolves" — the claim was written first and was wrong.)
  //
  // 🔴 `summaryEnabled`, NOT `isAuthor`, IS WHAT DECIDES WHETHER THERE IS ANYTHING TO WAIT
  // FOR — and that is a correction to this predicate, not a restatement of it. It read
  // `!isAuthor || (isClient && isFetched)`, which is `false` FOREVER for an author whose
  // query is disabled: `appBlocks` is store-runtime access while the PAGE gate is
  // `hasAppsStoreAccess` (`appListings || appBlocks || appListingsPublicExternal`), so an
  // author holding `appListings` alone reaches this page with the query switched off. Under
  // the old spelling they posted no `view` at all — the same silently-truncated denominator
  // the paragraph above rejects for the error cohort — and once `settled` also gates the
  // RENDER they would have sat under the skeleton permanently. The all-false summary is
  // that viewer's CORRECT and FINAL answer (see the `enabled` note above), so they settle
  // immediately, on the first paint, exactly like a non-author. A non-author is still
  // covered: `summaryEnabled` includes `isAuthor`, so it is false for them and `pending` is
  // false, which is why there is no separate `!isAuthor ||` term any more.
  const viewed = useRef(false);
  const summaryPending = summaryEnabled && !(isClient && isFetched);
  const settled = !summaryPending;
  useEffect(() => {
    if (viewed.current || !settled) return;
    viewed.current = true;
    track('view', state);
  }, [settled, state, track]);

  const onCopyCommand = useCallback(() => track('cli_copy', state), [track, state]);
  const onCreateEntry = useCallback(() => track('create_entry', state), [track, state]);

  // 🔴 THE UNSETTLED WINDOW RENDERS NEITHER B NOR C, AND THAT IS THE BUG FIX. `state` is
  // computed from an all-false summary until `getNavSummary` lands, and
  // `resolveAppsBuildState` reads all-false as `first-app` — so every author who HAS apps
  // used to be shown "Ship your first app" on the server render and on the first client
  // paint, then swapped to their workbench. Wrong screen, every visit. The skeleton commits
  // to neither; see `AppsBuildBodySkeleton` for why it deliberately mirrors neither.
  //
  // 🔴 IT IS THE SAME `settled` THE `view` EVENT USES, ON PURPOSE. Two predicates here is
  // how the analytics start describing a screen nobody saw: a render gate that let B through
  // early, or a view gate that fired under the skeleton, would each re-open exactly the
  // phantom-`first-app` inflation the effect above exists to prevent. One boolean, both
  // consumers.
  //
  // 🔴 AND IT CANNOT SWALLOW STATE A. `settled` is derived from `summaryPending`, which is
  // `false` whenever the query is not enabled — and it is never enabled for a non-author. So
  // the pitch, the only PUBLIC-facing and deliberately-indexable state, still renders on the
  // server with no loading frame in front of it.
  if (!settled) return <AppsBuildBodySkeleton />;

  if (state === 'workbench') {
    return (
      <Stack gap="lg">
        <Group justify="space-between" align="center" wrap="wrap">
          {/*
            🔴 COMPOSED FROM THE KIND LABELS, NOT RETYPED — inherited verbatim from
            `/apps/mine`'s page subtitle along with the table itself. That subtitle spelled
            the kinds by hand once and drifted from every other surface, which is why this
            module is enrolled in `__tests__/standaloneWordingCallSites.test.ts`. Spelling
            them out here would re-open exactly that drift, one route later.
          */}
          <Text size="sm" c="dimmed">
            Apps you own and apps you collaborate on, {EMBEDDED_KIND_LABEL} and{' '}
            {STANDALONE_KIND_LABEL}. Open a row to see its submission history.
          </Text>
          <Button
            component={Link}
            href={CREATE_FLOW_HREF}
            onClick={onCreateEntry}
            leftSection={<IconPlus size={16} />}
            data-testid="apps-build-new-app"
          >
            New app
          </Button>
        </Group>
        <MyAppsBody />
        <BuildResourcesStrip onCopyCommand={onCopyCommand} />
      </Stack>
    );
  }

  if (state === 'first-app') {
    return (
      <Stack gap="lg" data-testid="apps-build-first-app">
        <Stack gap="xs">
          <Title order={2}>Ship your first app</Title>
          <Text size="sm" c="dimmed">
            Build on Civitai&apos;s web + AI infrastructure — a catalog of hundreds of thousands of
            models, generation paid in Buzz, hosting and identity handled. Three commands and you
            are running locally.
          </Text>
        </Stack>
        <Stack gap="sm">
          <CopyableCommand command={CLI_INSTALL_NPM} onCopy={onCopyCommand} />
          <CopyableCommand command={CLI_CREATE_SAMPLE_COMMAND} onCopy={onCopyCommand} />
          <CopyableCommand command={CLI_RUN_COMMAND} onCopy={onCopyCommand} />
        </Stack>
        <Group>
          <Button
            component={Link}
            href={CREATE_FLOW_HREF}
            onClick={onCreateEntry}
            rightSection={<IconArrowRight size={16} />}
            data-testid="apps-build-create-first"
          >
            Create your first app
          </Button>
        </Group>
      </Stack>
    );
  }

  // State A — the pitch. The ONLY public-facing state, and the default: it needs no
  // session and no query, so it is what a logged-out admitted viewer sees.
  return (
    <Stack gap="xl" data-testid="apps-build-pitch">
      <GetStartedBody onCopyCommand={onCopyCommand} />
      <Alert
        color="blue"
        variant="light"
        title="Publishing is invite-only right now"
        data-testid="apps-build-request-access"
      >
        <Stack gap="sm" align="flex-start">
          <Text size="sm">
            Anyone can build and run an app locally with the CLI — the quickstart above works today.
            Publishing one to the Civitai store is still limited to a curated group while the
            platform is in beta.
          </Text>
          <Button
            component="a"
            href={APPS_REQUEST_ACCESS_HREF}
            target="_blank"
            rel="noopener noreferrer"
            onClick={() => track('request_access', 'pitch')}
            variant="light"
            leftSection={<IconBrandDiscord size={16} />}
          >
            Ask about access
          </Button>
        </Stack>
      </Alert>
    </Stack>
  );
}

/**
 * The pitch, DEMOTED for the workbench. An author who already has apps does not need the
 * "what you get" marketing above their app table every visit, but the quickstart commands
 * are the thing they come back for — so the resources live on, collapsed, below the list.
 * Collapsed by default and cheap: `GetStartedBody` is not mounted here at all, only the
 * three commands, so the workbench does not pay for the hero image.
 */
function BuildResourcesStrip({ onCopyCommand }: { onCopyCommand: () => void }) {
  const [opened, { toggle }] = useDisclosure(false);
  return (
    <Stack gap="xs">
      <Divider />
      <Button
        variant="subtle"
        size="xs"
        onClick={toggle}
        aria-expanded={opened}
        w="fit-content"
        leftSection={<IconTerminal2 size={16} />}
        data-testid="apps-build-resources-toggle"
        rightSection={
          <IconChevronDown
            size={16}
            style={{
              transform: opened ? 'rotate(180deg)' : undefined,
              transition: 'transform 150ms ease',
            }}
          />
        }
      >
        {opened ? 'Hide developer resources' : 'Developer resources'}
      </Button>
      <Collapse in={opened} data-testid="apps-build-resources">
        <Stack gap="sm">
          <CopyableCommand command={CLI_INSTALL_NPM} onCopy={onCopyCommand} />
          <CopyableCommand command={CLI_CREATE_SAMPLE_COMMAND} onCopy={onCopyCommand} />
          <CopyableCommand command={CLI_RUN_COMMAND} onCopy={onCopyCommand} />
        </Stack>
      </Collapse>
    </Stack>
  );
}
