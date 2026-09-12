import {
  ActionIcon,
  Anchor,
  Badge,
  Button,
  Card,
  Center,
  Divider,
  Group,
  Loader,
  NumberInput,
  Select,
  Stack,
  Tabs,
  Text,
  Tooltip,
} from '@mantine/core';
import { openConfirmModal } from '@mantine/modals';
import {
  IconEyeOff,
  IconHistory,
  IconPlugConnected,
  IconSettings,
  IconShieldLock,
  IconTrash,
} from '@tabler/icons-react';
import Link from 'next/link';
import { useRouter } from 'next/router';
import { useMemo, useState } from 'react';
import { NotFound } from '~/components/AppLayout/NotFound';
import { openAppSettingsModal } from '~/components/Apps/AppSettingsModal';
import { Meta } from '~/components/Meta/Meta';
import { AppsPageLayout } from '~/components/Apps/AppsPageLayout';
import { AppsCardGrid } from '~/components/Apps/appsWideLayout';
import { groupSubscriptionsByApp } from '~/components/Apps/groupSubscriptionsByApp';
import type { GroupedApp } from '~/components/Apps/groupSubscriptionsByApp';
import { useHiddenBlockList, unhideBlock } from '~/components/AppBlocks/hiddenBlocks';
import { useFeatureFlags, useOptionalFeatureFlags } from '~/providers/FeatureFlagsProvider';
import type {
  AvailableBlock,
  SubscriptionRecord,
} from '~/server/schema/blocks/subscription.schema';
import { BlockScopeList } from '~/components/Apps/BlockScopeList';
import { AppActivityPanel } from '~/components/Apps/AppActivityPanel';
import {
  ACTIVITY_TAB_LABELS,
  ACTIVITY_TAB_QUERY_KEY,
  activityTabQuery,
  isActivityTab,
  isActivityTabVisible,
  resolveActivityTab,
  visibleActivityTabs,
} from '~/components/Apps/appsActivityTabs';
import type { ActivityTab } from '~/components/Apps/appsActivityTabs';
import { resolveActivityPageAccess } from '~/components/Apps/resolveActivityPageAccess';
import { canAccessAppsActivity, hasAppsStoreAccess } from '~/shared/utils/app-blocks-access';
import {
  BLOCK_CONSENT_BUDGET_DEFAULT_PER_DAY,
  BLOCK_CONSENT_BUDGET_LOW_WARN_PER_DAY,
  BLOCK_CONSENT_BUDGET_MAX_PER_DAY,
  BLOCK_CONSENT_BUDGET_MIN_PER_DAY,
} from '~/shared/constants/block-scope.constants';
import { createServerSideProps } from '~/server/utils/server-side-helpers';
import { formatDate } from '~/utils/date-helpers';
import { getLoginLink } from '~/utils/login-helpers';
import { showErrorNotification, showSuccessNotification } from '~/utils/notifications';
import { trpc } from '~/utils/trpc';

/** 🔴 The gate is the SHARED `resolveActivityPageAccess`, never an inline flag read —
 *  and it is `appBlocks || appBlocksPages`. See `canAccessAppsActivity`. */
export const getServerSideProps = createServerSideProps({
  useSession: true,
  resolver: async ({ features, session, ctx }) =>
    resolveActivityPageAccess({
      features,
      user: session?.user,
      loginDestination: getLoginLink({ returnUrl: ctx.resolvedUrl }),
    }),
});

const PIN_LATEST_VALUE = '__latest__';

interface PinnedInstallRowProps {
  sub: SubscriptionRecord;
}

/**
 * One compact line for a single pinned (per-model-install) subscription —
 * slot_id non-NULL + target_model_ids non-empty. Carries the same controls
 * the old SubscriptionRow gave pinned rows: the model link badge(s), the
 * version Select (Latest + availableVersions), and the Uninstall action.
 *
 * Pinned subs are removed via `blocks.uninstallFromModel` (using the row's
 * preserved blockInstanceId) so the rank-1 NOT EXISTS in listForModel's SQL
 * stops suppressing platform defaults for the same slot. The original cache
 * invalidations (listMySubscriptions, listMyScopeGrants, listForModel) are
 * preserved verbatim.
 */
function PinnedInstallRow({ sub }: PinnedInstallRowProps) {
  const utils = trpc.useUtils();
  const manifest = sub.manifest;
  const uninstallMutation = trpc.blocks.uninstallFromModel.useMutation({
    onSuccess: async () => {
      await Promise.all([
        utils.blocks.listMySubscriptions.invalidate(),
        utils.blocks.listMyScopeGrants.invalidate(),
        // Pinned subs render on exactly one modelId; targeted cache bust.
        sub.targetModelIds && sub.targetModelIds[0]
          ? utils.blocks.listForModel.invalidate({ modelId: sub.targetModelIds[0] })
          : Promise.resolve(),
      ]);
      showSuccessNotification({ title: 'Removed', message: 'Uninstalled from model.' });
    },
    onError: (e) =>
      showErrorNotification({ title: 'Could not uninstall', error: new Error(e.message) }),
  });
  const pinVersionMutation = trpc.blocks.setSubscriptionPinnedVersion.useMutation({
    onSuccess: async () => {
      await utils.blocks.listMySubscriptions.invalidate();
    },
    onError: (e) =>
      showErrorNotification({ title: 'Could not change version', error: new Error(e.message) }),
  });

  const versionOptions: { value: string; label: string }[] = [
    {
      value: PIN_LATEST_VALUE,
      label: sub.currentVersion ? `Latest (${sub.currentVersion})` : 'Latest',
    },
    ...sub.availableVersions.map((v) => ({ value: v.version, label: v.version })),
  ];

  const pinnedTo = (sub.targetModelIds ?? []).map((id) => ({
    id,
    name: sub.pinnedModelNames?.[id] ?? `Model ${id}`,
  }));

  const onConfirmUninstall = () => {
    const targetName = pinnedTo[0]?.name ?? 'this model';
    openConfirmModal({
      title: `Uninstall ${manifest.name ?? sub.blockId}?`,
      children: (
        <Stack gap="xs">
          <Text size="sm">
            This removes the install row entirely. The app will stop appearing on{' '}
            <strong>{targetName}</strong>. Any platform default for the same slot will become
            eligible again. The app's data and any other installs of it are untouched.
          </Text>
        </Stack>
      ),
      labels: { confirm: 'Uninstall', cancel: 'Cancel' },
      confirmProps: { color: 'red' },
      onConfirm: () => {
        if (sub.blockInstanceId) {
          uninstallMutation.mutate({ blockInstanceId: sub.blockInstanceId });
        }
      },
    });
  };

  return (
    <Group justify="space-between" wrap="nowrap" gap="sm" align="center">
      <Group gap={4} wrap="wrap" style={{ minWidth: 0, flex: 1 }}>
        {pinnedTo.map(({ id, name }) => (
          <Badge
            key={id}
            size="xs"
            variant="outline"
            component={Link}
            href={`/models/${id}`}
            style={{ cursor: 'pointer' }}
          >
            {name}
          </Badge>
        ))}
        {!sub.enabled && (
          <Badge size="xs" variant="light" color="gray">
            Disabled
          </Badge>
        )}
      </Group>
      <Group gap="xs" wrap="nowrap" align="center">
        <Tooltip
          label="Which manifest the host uses for this install. Latest tracks the most recent approved release; pinning a version freezes scopes + settings to that version's manifest."
          multiline
          w={280}
          withArrow
        >
          <Select
            size="xs"
            w={170}
            data={versionOptions}
            value={sub.pinnedVersion ?? PIN_LATEST_VALUE}
            disabled={pinVersionMutation.isPending}
            onChange={(value) => {
              if (value == null) return;
              const next = value === PIN_LATEST_VALUE ? null : value;
              if (next === sub.pinnedVersion) return;
              pinVersionMutation.mutate({
                subscriptionId: sub.id,
                version: next,
              });
            }}
            comboboxProps={{ withinPortal: true }}
            aria-label={`Version for ${manifest.name ?? sub.blockId} on ${
              pinnedTo[0]?.name ?? 'model'
            }`}
          />
        </Tooltip>
        <ActionIcon
          variant="default"
          color="red"
          disabled={uninstallMutation.isPending}
          onClick={onConfirmUninstall}
          title="Uninstall"
        >
          <IconTrash size={16} />
        </ActionIcon>
      </Group>
    </Group>
  );
}

interface InstalledAppCardProps {
  app: GroupedApp;
  onManage: (sub: SubscriptionRecord) => void;
}

/**
 * One row per installed app. Collapses the two blanket "surfaces"
 * (publisher / viewer) into a single card with a "Shows on" summary; pinned
 * per-model installs are listed in a subsection below. Toggling which
 * surfaces are active happens through the existing AppSettingsModal (the
 * Manage button), which already supports both scopes.
 */
/** 🔴 EXPORTED SO ITS GEOMETRY CAN BE MEASURED — `AppsWideLayout.geometry.test.tsx`
 *  mounts THIS card rather than a fixture copy of its markup. */
export function InstalledAppCard({ app, onManage }: InstalledAppCardProps) {
  const { blanketPublisher, blanketViewer, pinned } = app;
  const name = app.manifest.name ?? app.blockId;
  // Any blanket sub on the app is enough to seed the Manage modal — it
  // re-scans all subs for the appBlockId internally.
  const manageSeed = blanketPublisher ?? blanketViewer ?? pinned[0];
  const hasBlanket = !!(blanketPublisher || blanketViewer);

  return (
    <Card withBorder padding="sm" radius="md">
      <Stack gap="sm">
        <Group justify="space-between" wrap="nowrap" gap="md" align="flex-start">
          <Text fw={600} className="truncate" style={{ minWidth: 0, flex: 1 }}>
            {name}
          </Text>
          {manageSeed && (
            <Button
              variant="default"
              size="xs"
              leftSection={<IconSettings size={14} />}
              onClick={() => onManage(manageSeed)}
            >
              Manage
            </Button>
          )}
        </Group>

        <Group gap="xs" wrap="wrap" align="center">
          <Text size="xs" c="dimmed">
            Shows on:
          </Text>
          {hasBlanket ? (
            <>
              {blanketPublisher && (
                <Tooltip label="Visible to anyone who views your models." withArrow>
                  <Badge
                    size="sm"
                    variant="light"
                    color={blanketPublisher.enabled ? undefined : 'gray'}
                  >
                    On my models
                    {!blanketPublisher.enabled ? ' · Disabled' : ''}
                  </Badge>
                </Tooltip>
              )}
              {blanketViewer && (
                <Tooltip label="Visible only to you, on every model page you open." withArrow>
                  <Badge
                    size="sm"
                    variant="light"
                    color={blanketViewer.enabled ? undefined : 'gray'}
                  >
                    On every page I view
                    {!blanketViewer.enabled ? ' · Disabled' : ''}
                  </Badge>
                </Tooltip>
              )}
            </>
          ) : (
            <Text size="xs" c="dimmed" fs="italic">
              Not on a blanket surface — pinned to specific models below.
            </Text>
          )}
        </Group>

        {pinned.length > 0 && (
          <>
            <Divider />
            <Stack gap="xs">
              <Text size="xs" c="dimmed" fw={500}>
                Pinned to specific models
              </Text>
              {pinned.map((sub) => (
                <PinnedInstallRow key={sub.id} sub={sub} />
              ))}
            </Stack>
          </>
        )}
      </Stack>
    </Card>
  );
}

/**
 * 🔴 THE `/apps` ANCHOR IS GATED ON `hasAppsStoreAccess`, AND THE GAP IT CLOSES IS THIS
 * PR'S OWN. `/apps` SSR-gates on `resolveAppsPageAccess` → `hasAppsStoreAccess` =
 * `appListings || appBlocks || appListingsPublicExternal`. `appBlocksPages` is NOT one of
 * those disjuncts — but this PAGE now admits `appBlocks || appBlocksPages`. So the cohort
 * criterion 2 widened the page for can hold `appBlocksPages` ALONE, load this page, and
 * be offered a marketplace link that answers `notFound`: the #3899 / #4668 defect class
 * (an affordance into a 404), reintroduced by the widening rather than by a drifted rule.
 *
 * The CTA is OMITTED rather than reworded — a viewer with no store has no destination, so
 * there is no honest link text. `useOptionalFeatureFlags` (not `useFeatureFlags`) so the
 * absence of a provider REMOVES the affordance instead of throwing; same fail-closed
 * decision as `ActivityAppName`.
 */
function EmptyState({ label }: { label: string }) {
  const canSeeStore = hasAppsStoreAccess(useOptionalFeatureFlags());
  return (
    <Center py="md">
      <Stack align="center" gap="xs">
        <IconPlugConnected size={28} opacity={0.5} />
        {/* `ta`/`maw` so a two-sentence label wraps as a centred block rather than one
            page-wide line — the labels here now name what the tab covers, not just what
            is absent. Mirrors `HiddenBlocksPanel`'s own empty state. */}
        <Text size="sm" c="dimmed" ta="center" maw={460}>
          {label}
        </Text>
        {canSeeStore && (
          <Anchor component={Link} href="/apps" size="sm" data-testid="apps-empty-marketplace-link">
            Browse the marketplace
          </Anchor>
        )}
      </Stack>
    </Center>
  );
}

/**
 * Surface where the user has the app installed in one short string.
 */
function buildSurfaceLine(surfaces: {
  modelInstallCount: number;
  subscriptionScopes: string[];
}): string {
  const parts: string[] = [];
  if (surfaces.modelInstallCount > 0) {
    parts.push(
      `${surfaces.modelInstallCount} model install${surfaces.modelInstallCount === 1 ? '' : 's'}`
    );
  }
  if (surfaces.subscriptionScopes.length > 0) {
    parts.push(
      `Subscriptions: ${surfaces.subscriptionScopes
        .map((s) => (s === 'publisher_all_my_models' ? 'publisher' : 'viewer'))
        .join(' / ')}`
    );
  } else if (surfaces.modelInstallCount === 0) {
    /* 🔴 THE GRANT-ONLY ROW — a consented full-page app, which THIS PR makes reachable for
       the first time: every earlier row came from a subscription, seeded with either
       `modelInstallCount > 0` or one scope, so `0 / 0` could not occur and the previous text
       ("Subscriptions: none") was unreachable. Replaced because on a consent surface it
       reads as "this app has no access", under copy promising "…and where you have it".
       This is the one copy site a literal sweep cannot find — it is computed. */
    parts.push('Granted at consent · no install or subscription');
  }
  return parts.join(' · ');
}

/** The ONE scope in the vocabulary that can spend the viewer's Buzz. */
const SPEND_SCOPE = 'ai:write:budgeted';

/**
 * The per-app daily Buzz limit, rendered and EDITABLE.
 *
 * 🔴 WHY THIS EXISTS AT ALL. Before it, the budget was write-once and invisible: the
 * consent modal is the only writer and it only sends the field while
 * `ai:write:budgeted` is still MISSING, which is true exactly once per app, forever.
 * So a user could set a limit and then had no way to raise it, lower it, clear it, or
 * even SEE it — and a low value (the floor is 1) meant every generation from that app
 * was refused with no recoverable path through the product. The server raise/clear
 * path already existed (`blocks.grantScopes`); nothing was wired to it.
 *
 * 🔴 THE `scopes` PAYLOAD IS DELIBERATELY `[SPEND_SCOPE]` AND MUST STAY THAT WAY.
 * `grantScopes` is ADDITIVE over the scope set, so sending the app's manifest scopes
 * here would GRANT every scope the app declares — a silent widening performed by a
 * control that says "limit". Re-sending the one scope the user has already granted
 * (which `spendScopeGranted` is exactly the proof of) unions with itself: the stored
 * set cannot change. It is also the scope the server requires to be present for a
 * budget to mean anything, so the write can never be the ignored-budget no-op.
 *
 * CLEARING sends an explicit `null`, which is the service's "clear it" state — a
 * DIFFERENT thing from omitting the key (leave it alone), and the only caller of that
 * branch.
 *
 * ⚠️ KNOWN LIMIT, STATED RATHER THAN PAPERED OVER: `grantScopes` requires the app to be
 * `approved` AND the sent scope to be inside `manifest ∩ approvedScopes`. If an app is
 * later un-approved, or a moderator narrows its approved set so it no longer includes
 * `ai:write:budgeted`, this control surfaces the server's error instead of editing —
 * the user's stored limit is then not editable here. It is also not ENFORCING anything
 * in that state (no token can carry the spend scope, so no spend reaches the budget),
 * so nothing is stuck at a ceiling; the limit is simply frozen until the app is
 * approved again. Fixing it properly means a budget-only server path that does not go
 * through the scope ceiling.
 */
function AppBudgetControl({
  appBlockId,
  appName,
  budget,
}: {
  appBlockId: string;
  appName: string;
  budget: number | null;
}) {
  const utils = trpc.useUtils();
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState<number | string>(
    budget ?? BLOCK_CONSENT_BUDGET_DEFAULT_PER_DAY
  );
  const mutation = trpc.blocks.grantScopes.useMutation({
    onSuccess: async () => {
      await utils.blocks.listMyScopeGrants.invalidate();
      setEditing(false);
    },
    onError: (e) =>
      showErrorNotification({ title: 'Could not change the limit', error: new Error(e.message) }),
  });

  // Mantine's NumberInput hands back a string mid-edit (and '' when cleared), so
  // narrow to a real integer in range before it can reach the mutation. The server
  // re-validates the same bounds regardless — this only keeps the request well-formed
  // and the Save button honest.
  const parsed = typeof value === 'number' ? value : Number.parseInt(String(value), 10);
  const valid =
    Number.isInteger(parsed) &&
    parsed >= BLOCK_CONSENT_BUDGET_MIN_PER_DAY &&
    parsed <= BLOCK_CONSENT_BUDGET_MAX_PER_DAY;

  const save = (next: number | null) =>
    mutation.mutate({ appBlockId, scopes: [SPEND_SCOPE], buzzBudgetPerDay: next });

  if (!editing) {
    return (
      <Group justify="space-between" gap="xs" wrap="nowrap" data-testid="app-budget-row">
        <Text size="xs" c="dimmed" data-testid="app-budget-value">
          {budget === null
            ? 'Daily Buzz limit: none — only your account-wide daily cap applies'
            : `Daily Buzz limit: ${budget.toLocaleString()} Buzz/day`}
        </Text>
        <Button
          size="compact-xs"
          variant="subtle"
          data-testid="app-budget-edit"
          onClick={() => {
            setValue(budget ?? BLOCK_CONSENT_BUDGET_DEFAULT_PER_DAY);
            setEditing(true);
          }}
        >
          {budget === null ? 'Set limit' : 'Change'}
        </Button>
      </Group>
    );
  }

  return (
    <Stack gap={6} data-testid="app-budget-editor">
      <NumberInput
        size="xs"
        label={`Daily Buzz limit for ${appName}`}
        description={`Most this app can spend of your Buzz per day. Max ${BLOCK_CONSENT_BUDGET_MAX_PER_DAY.toLocaleString()}.`}
        min={BLOCK_CONSENT_BUDGET_MIN_PER_DAY}
        max={BLOCK_CONSENT_BUDGET_MAX_PER_DAY}
        step={100}
        allowDecimal={false}
        allowNegative={false}
        value={value}
        onChange={setValue}
        error={valid ? null : 'Enter a whole number within the allowed range'}
        data-testid="app-budget-input"
      />
      {/* A very low limit is a real setting, not a mistake — but it is also the one
          that makes an app look broken, so say what it does at the point it is set.
          This is what keeps the floor of 1 tolerable; see BLOCK_CONSENT_BUDGET_MIN_PER_DAY.

          🔴 FOUR RULES, ONE PER WORDING THAT SHIPPED HERE AND WAS FALSE. Each was
          introduced by the fix for the previous one, so read all four before editing.
          (1) RESERVES, never COSTS — a recipe's `maxBuzz` is the worst case reserved up
              front and settled back to actual, so the real price is far lower
              (zimage-turbo estimates 20 against a 90 ceiling; a warm starter run
              measured 4). "costs 90 per run" overstated by up to ~22×.
          (2) HEDGE — the consent budget is path-agnostic while these bounds are not.
              `textToImage` reserves its live whatIf quote, is not bounded below by LOW
              (the platform's per-gen default is 10), and has NO settle-back, so neither
              "will not cover" nor an unqualified "settles back" is true there.
          (3) NO CLOSED UPPER BOUND EXISTS — do not name one. "up to 180 on the priciest"
              was false because the inline customComfy arm reserves an app-declared
              ceiling up to INLINE_MAX_BUZZ = 250, un-dev-gated, and textToImage is
              bounded by neither figure. Say "and more on others" and stop.
          (4) Subject is the RUN, not "this app" — registry steps cost from 1 Buzz, so a
              step-priced app keeps working under this threshold, and that user is exactly
              who MIN=1 exists to protect.

          🔴 STILL OPEN, and this note is its only record — do not delete it again. The
          warning renders only below LOW (90), so a user at 100/day is told nothing while
          a qwen-image run (reserves 180) or an inline app (up to 250) is still refused.
          Thresholding on HIGH, or on INLINE_MAX_BUZZ, would close it at the cost of
          warning step-only apps that are fine. Deliberately not decided here. */}
      {valid && parsed < BLOCK_CONSENT_BUDGET_LOW_WARN_PER_DAY ? (
        <Text size="xs" c="orange" data-testid="app-budget-low-warning">
          {parsed.toLocaleString()} Buzz/day may be too low. A single image generation reserves Buzz
          up front before it runs — {BLOCK_CONSENT_BUDGET_LOW_WARN_PER_DAY} Buzz on the cheapest
          recipe engine, and more on the other engines — and is refused if that reservation exceeds
          your limit, even in cases where the run itself would have cost less. Step-based actions,
          from 1 Buzz, still run. You can change it here at any time.
        </Text>
      ) : null}
      <Group gap="xs" justify="flex-end">
        <Button
          size="compact-xs"
          variant="default"
          disabled={mutation.isPending}
          onClick={() => setEditing(false)}
        >
          Cancel
        </Button>
        {budget !== null ? (
          <Button
            size="compact-xs"
            variant="light"
            color="gray"
            loading={mutation.isPending}
            data-testid="app-budget-clear"
            onClick={() => save(null)}
          >
            Remove limit
          </Button>
        ) : null}
        <Button
          size="compact-xs"
          color="yellow"
          disabled={!valid}
          loading={mutation.isPending}
          data-testid="app-budget-save"
          onClick={() => save(parsed)}
        >
          Save
        </Button>
      </Group>
    </Stack>
  );
}

function ScopeGrantsPanel() {
  const { data: grants, isLoading } = trpc.blocks.listMyScopeGrants.useQuery();

  if (isLoading) {
    return (
      <Center py="xl">
        <Loader />
      </Center>
    );
  }
  if (!grants || grants.length === 0) {
    /* 🔴 NOT "no app has any access to your account" — that is the claim this string used
       to make, and it was false.
       ⚠️ THE REASON HAS NARROWED, SO THE SENTENCE HAS WIDENED. #4722 wrote "reads
       `block_user_subscriptions` ONLY … silent about full-page apps", which was true then;
       `listMyScopeGrants` now also enumerates live `app_user_scope_grants`, so a consented
       full-page app DOES appear and is no longer part of the silence. ⚠️ TWO populations
       remain, not one: (a) blocks OTHER people installed, which carry no row of the
       viewer's; and (b) an app the viewer NEVER installed or subscribed to whose scopes are
       ALL in `CONSENT_EXEMPT_SCOPES` (`scope-grant.service.ts`) — `partitionByConsent`
       returns `missing: []`, so no consent modal fires and nothing writes a grant row, yet
       exempt scopes like `collections:write:self` still write to the account.
       ⚠️ The "never installed" half is load-bearing and an earlier draft omitted it: install
       and subscribe call `recordInstallConsent` UNCONDITIONALLY (`block-registry.service.ts`
       :2285, :2921 — not on the modal path), and `recordScopeGrant` has no empty-scopes early
       return, so an INSTALLED all-exempt app does get a row, with `grantedScopes: []`.
       The string stays true — they granted nothing — but the silence is wider than
       "other people's installs". */
    return (
      <EmptyState label="No apps installed, subscribed to, or granted permissions yet. This tab covers your own installs and consents — Recent activity is the full record of what apps have done on your account." />
    );
  }
  return (
    <AppsCardGrid testId="apps-installed-grants-grid">
      {grants.map((grant) => (
        <Card key={grant.appBlockId} withBorder padding="sm" radius="md">
          <Stack gap="xs">
            <Group justify="space-between" wrap="nowrap">
              <Stack gap={2} style={{ minWidth: 0, flex: 1 }}>
                <Group gap="xs">
                  <Text fw={600} className="truncate">
                    {grant.name}
                  </Text>
                  <Badge size="xs" variant="outline">
                    {grant.slug}
                  </Badge>
                </Group>
                <Text size="xs" c="dimmed">
                  {buildSurfaceLine(grant.surfaces)}
                </Text>
              </Stack>
            </Group>
            <Divider />
            <BlockScopeList scopes={grant.scopes} />
            {/* Only for an app the viewer has actually GRANTED the spend scope to —
                `spendScopeGranted` is the grant row, not the manifest. A budget on an
                app that cannot spend bounds nothing, and the server would ignore the
                write. */}
            {grant.spendScopeGranted ? (
              <>
                <Divider />
                <AppBudgetControl
                  appBlockId={grant.appBlockId}
                  appName={grant.name}
                  budget={grant.buzzBudgetPerDay}
                />
              </>
            ) : null}
          </Stack>
        </Card>
      ))}
    </AppsCardGrid>
  );
}

/**
 * Viewer-local "Hide app block" restore surface. The ⋯ menu on a block's host
 * trust-frame lets a viewer hide an owner-installed block; that lives only in
 * this browser's localStorage (see components/AppBlocks/hiddenBlocks.ts), so it
 * has no server-side row and isn't part of the user's installs/subscriptions —
 * hence its own tab. "Restore" un-hides it, and the block reappears on the
 * model page (reactively, via the shared change event).
 */
function HiddenBlocksPanel() {
  const hidden = useHiddenBlockList();

  if (hidden.length === 0) {
    return (
      <Center py="md">
        <Stack align="center" gap="xs">
          <IconEyeOff size={28} opacity={0.5} />
          <Text size="sm" c="dimmed" ta="center" maw={420}>
            You haven't hidden any apps. Use the ⋯ menu on an app to hide it on this device — it
            only affects what you see, never the publisher or other viewers.
          </Text>
        </Stack>
      </Center>
    );
  }

  return (
    /* `gap={12}` — this list was `<Stack gap="sm">`, not `md`. Carrying its own number
       keeps `APPS_CARD_LIST_MIN_COLUMN`'s "nothing a 1440 or 1920 monitor shows changes"
       literally true on this tab; the column ladder is identical at both gaps. */
    <AppsCardGrid testId="apps-installed-hidden-grid" gap={12}>
      {hidden.map((block) => (
        <Card key={block.blockInstanceId} withBorder padding="sm" radius="md">
          <Group justify="space-between" wrap="nowrap" gap="md" align="center">
            <Stack gap={2} style={{ minWidth: 0, flex: 1 }}>
              <Text fw={600} className="truncate">
                {block.appName ?? 'App'}
              </Text>
              <Group gap={6} wrap="wrap">
                {block.modelId ? (
                  <Anchor component={Link} href={`/models/${block.modelId}`} size="xs">
                    {block.modelName ?? `Model ${block.modelId}`}
                  </Anchor>
                ) : null}
                {block.hiddenAt > 0 && (
                  <Text size="xs" c="dimmed">
                    Hidden {formatDate(new Date(block.hiddenAt), 'YYYY-MM-DD')}
                  </Text>
                )}
              </Group>
            </Stack>
            <Button
              variant="default"
              size="xs"
              onClick={() => {
                unhideBlock(block.blockInstanceId);
                showSuccessNotification({
                  title: 'Restored',
                  message: `${block.appName ?? 'App'} will show again.`,
                });
              }}
            >
              Restore
            </Button>
          </Group>
        </Card>
      ))}
    </AppsCardGrid>
  );
}

/**
 * The icon for each tab. Lives here rather than beside `ACTIVITY_TAB_LABELS` because
 * `appsActivityTabs.ts` is deliberately React-free (that is what lets it run in the
 * node-env `unit` project). Typed as a total `Record` so adding a tab to
 * `ACTIVITY_TAB_VALUES` fails the build here rather than rendering an undefined icon.
 */
const ACTIVITY_TAB_ICONS: Record<ActivityTab, typeof IconHistory> = {
  activity: IconHistory,
  subscriptions: IconPlugConnected,
  permissions: IconShieldLock,
  hidden: IconEyeOff,
};

export default function AppActivityPage() {
  const features = useFeatureFlags();
  const router = useRouter();
  // 🔴 The gated tabs' predicate is the `appBlocks` SLOT flag; the PAGE's is
  // `appBlocks || appBlocksPages`. A tab's predicate is its content's own gate,
  // restated — and this one is NON-VACUOUS only because the page gate widened.
  // `SLOT_GATED_ACTIVITY_TABS` is the ledger of which tabs that covers, and everything
  // below — the bar, the panels and the `?tab=` resolver — reads it through this ONE
  // value, so none of them can disagree with another.
  const visibility = { canSeeSlotGatedTabs: !!features.appBlocks };
  const { data: subs, isLoading } = trpc.blocks.listMySubscriptions.useQuery(undefined, {
    enabled: visibility.canSeeSlotGatedTabs,
  });

  // 🔴 URL-backed, controlled tabs. `resolveActivityTab` returns the default for an
  // absent value, so an empty first-render `router.query` renders what SSR did.
  const activeTab = resolveActivityTab(router.query[ACTIVITY_TAB_QUERY_KEY], visibility);

  // 🔴 THE BAR IS DERIVED, NOT HAND-SPELLED. This used to be four `canSee… &&` guards
  // inline in the JSX below — four sites the node-env `unit` project could not see, so
  // deleting one of them (rendering a tab whose panel stayed gated) left that whole
  // suite green and only the report-only `component` tier caught it. Mapping the
  // ledger's own output means the unit-tier guard on `SLOT_GATED_ACTIVITY_TABS` now
  // governs what actually renders.
  const visibleTabs = visibleActivityTabs(visibility);

  const groupedApps = useMemo(() => groupSubscriptionsByApp(subs ?? []), [subs]);

  function handleManage(sub: SubscriptionRecord) {
    // Build an AvailableBlock-shaped object from the subscription's
    // denormalised app_block row so we can reuse the marketplace modal.
    const block: AvailableBlock = {
      id: sub.appBlockId,
      blockId: sub.blockId,
      appId: sub.appId,
      appName: null,
      manifest: sub.manifest as Record<string, unknown>,
      installCount: 0,
      // E3 marketplace-card fields — unused on the Manage path (modal-only).
      category: null,
      scopesSummary: [],
      // An installed app is on-platform by definition (external-link apps have
      // no install) — never an external listing on this path.
      externalUrl: null,
      // Card cover — unused on the Manage path (the modal renders no cover) and
      // the subscription row carries no screenshot data, so null.
      coverUrl: null,
    };
    const existingByScope: Partial<Record<typeof sub.scope, SubscriptionRecord>> = {};
    for (const candidate of subs ?? []) {
      if (candidate.appBlockId === sub.appBlockId) {
        existingByScope[candidate.scope] = candidate;
      }
    }
    openAppSettingsModal({ block, existingByScope });
  }

  // The client-side re-check reads the SAME predicate the SSR gate does, so the two
  // cannot answer differently for one viewer.
  if (!canAccessAppsActivity(features)) return <NotFound />;

  return (
    <>
      <Meta title="App activity — Civitai" deIndex />
      <AppsPageLayout
        title="Your app activity"
        subtitle="What Civitai Apps have done on your account, what the apps you've installed declare they can access, and where they show up."
      >
        {/* 🔴 CONTROLLED, NOT `defaultValue` — that is what puts the selection in the
            URL. `replace` + `shallow`: no re-run of `getServerSideProps`, and no history
            entry per click (which would turn Back into a tab-by-tab rewind). */}
        <Tabs
          value={activeTab}
          onChange={(value) => {
            if (!isActivityTab(value)) return;
            void router.replace(
              { pathname: router.pathname, query: activityTabQuery(value, router.query) },
              undefined,
              { shallow: true }
            );
          }}
          variant="outline"
        >
          {/* 🔴 A `< 2` COLLAPSE, MIRRORING `AppsSubNav`'s `links.length < 2` — and it is
              REACHABLE, which is why it exists. A viewer without the slot flag sees only
              `Recent activity`, and a one-tab bar is chrome offering no choice. (The
              earlier state of this file argued the floor was 2 and declined to build a
              branch that could never run; gating `permissions` inverted that.) */}
          {visibleTabs.length >= 2 && (
            <Tabs.List>
              {visibleTabs.map((tab) => {
                const Icon = ACTIVITY_TAB_ICONS[tab];
                return (
                  <Tabs.Tab key={tab} value={tab} leftSection={<Icon size={14} />}>
                    {ACTIVITY_TAB_LABELS[tab]}
                  </Tabs.Tab>
                );
              })}
            </Tabs.List>
          )}

          <Tabs.Panel value="activity" pt="md">
            <Stack gap="sm">
              <Text size="sm" c="dimmed">
                Recent actions apps have taken on your behalf — Buzz spends plus every scope-gated
                API call (read profile, read model, etc.).
              </Text>
              <AppActivityPanel />
            </Stack>
          </Tabs.Panel>

          {/* 🔴 THE PANEL IS GATED TOO, THROUGH THE SAME PREDICATE THE BAR USES. A
              `Tabs.Panel` with no tab is unreachable but still MOUNTS its children on
              every render. Reading `isActivityTabVisible` rather than a local boolean is
              what makes "the bar and the panels cannot disagree" a fact about the code. */}
          {isActivityTabVisible('subscriptions', visibility) && (
            <Tabs.Panel value="subscriptions" pt="md">
              {isLoading ? (
                <Center py="xl">
                  <Loader />
                </Center>
              ) : groupedApps.length === 0 ? (
                <EmptyState label="Nothing installed yet — browse the marketplace." />
              ) : (
                /* A GRID, NOT A `Stack` — the 640px dead-gap fix. Rationale + the measured
                   ladder: `APPS_CARD_LIST_MIN_COLUMN` in `~/components/Apps/appsPageWidths`. */
                <AppsCardGrid testId="apps-installed-apps-grid">
                  {groupedApps.map((app) => (
                    <InstalledAppCard key={app.appBlockId} app={app} onManage={handleManage} />
                  ))}
                </AppsCardGrid>
              )}
            </Tabs.Panel>
          )}

          {/* 🔴 GATED, AND ITS OWN DATA SOURCE IS WHY. `ScopeGrantsPanel`'s only read is
              `blocks.listMyScopeGrants`, whose `enforceAppBlocksFlag` middleware returns
              `[]` for a viewer without the slot flag — so ungated this showed the installs
              empty state to every such viewer, always. Gating it displays nothing that was
              ever displayed.

              🔴 THE COPY BELOW USED TO INSTRUCT AN ACTION THAT DOES NOT DO WHAT THE SENTENCE
              SAID: "to revoke access, remove the install or subscription on the Installs
              tab". Neither uninstall path touches the consent row.
              `BlockRegistry.deleteSubscription` deletes the `block_user_subscriptions` row
              and nothing else; `uninstallFromModel` additionally revokes the block INSTANCE
              token, which kills tokens already minted but leaves the grant standing. The
              grant lives in `app_user_scope_grants`, and the only writes to it anywhere in
              the repo are in `~/server/services/blocks/scope-grant.service.ts`, both of
              which set `revokedAt: null` — nothing writes a non-null `revoked_at` and
              nothing deletes a row. So `getGrantedScopes` keeps returning the same scopes
              afterwards and the next mint carries them with no fresh prompt. Withdrawing
              consent is genuinely not implemented; the copy says so rather than pointing at
              a control that does not do it. Do not soften this back into an instruction
              until a real revoke path exists. */}
          {isActivityTabVisible('permissions', visibility) && (
            <Tabs.Panel value="permissions" pt="md">
              <Stack gap="sm">
                <Text size="sm" c="dimmed">
                  The apps you've installed, subscribed to, or granted permissions to, what each one
                  declares it may use, and where you have it. Removing an install on the Installs
                  tab takes the app off that surface, but it does not withdraw a permission you have
                  already granted — withdrawing one is not possible yet. Recent activity is the full
                  record of what apps have actually done on your account.
                </Text>
                <ScopeGrantsPanel />
              </Stack>
            </Tabs.Panel>
          )}

          {/* 🔴 THE PANEL IS GATED TOO — same reason as `subscriptions` above: an
              unreachable `Tabs.Panel` still MOUNTS its children on every render. */}
          {isActivityTabVisible('hidden', visibility) && (
            <Tabs.Panel value="hidden" pt="md">
              <Stack gap="sm">
                <Text size="sm" c="dimmed">
                  Apps you've hidden on this device. Hiding is local to your browser — it never
                  affects the publisher's install or other viewers. Restore one to have it show on
                  its model page again.
                </Text>
                <HiddenBlocksPanel />
              </Stack>
            </Tabs.Panel>
          )}
        </Tabs>
      </AppsPageLayout>
    </>
  );
}
