import {
  Anchor,
  Badge,
  Button,
  Card,
  Center,
  Container,
  Divider,
  Group,
  List,
  Loader,
  Stack,
  Text,
  ThemeIcon,
  Title,
} from '@mantine/core';
import {
  IconArrowLeft,
  IconExternalLink,
  IconLock,
  IconPlugConnected,
  IconSettings,
  IconShieldCheck,
} from '@tabler/icons-react';
import Link from 'next/link';
import { useRouter } from 'next/router';
import { useMemo } from 'react';
import { NotFound } from '~/components/AppLayout/NotFound';
import { openAppSettingsModal } from '~/components/Apps/AppSettingsModal';
import { resolveAppsPageAccess } from '~/components/Apps/resolveAppsPageAccess';
import { LoginRedirect } from '~/components/LoginRedirect/LoginRedirect';
import { Meta } from '~/components/Meta/Meta';
import { useCurrentUser } from '~/hooks/useCurrentUser';
import { useFeatureFlags } from '~/providers/FeatureFlagsProvider';
import type {
  AvailableBlock,
  PublicAppDetail,
  SubscriptionRecord,
  SubscriptionScope,
} from '~/server/schema/blocks/subscription.schema';
import {
  SCOPE_DESCRIPTIONS,
  SLOT_DESCRIPTIONS,
} from '~/server/services/blocks/scope-descriptions.constants';
import { createServerSideProps } from '~/server/utils/server-side-helpers';
import { trpc } from '~/utils/trpc';

/**
 * F-E E2 — per-app marketplace detail page (`/apps/<appBlockId>`).
 *
 * 🔒 GATING INVARIANT (E2 — same as E1, do not violate):
 *   - The SSR resolver runs `resolveAppsPageAccess` FIRST: the `features.appBlocks`
 *     flag gate is the ONLY access control. A real anon / non-mod viewer does not
 *     satisfy the mod-segmented Flipt `app-blocks-enabled` flag, so they get
 *     `notFound`. The page is anon-CAPABLE in code (no session→login redirect)
 *     but DARK until the segment is widened at launch — there is intentionally
 *     NO hardcoded isModerator belt (that would break the eventual public flip).
 *   - `deIndex` stays ON in the page <Meta> (per-app OG/title/description are
 *     added now, but the page is not crawlable pre-launch — drop `deIndex` only
 *     at launch).
 *   - The `getAppDetail` query is the anon-capable public read path; it is gated
 *     by the SAME mod-segmented flag server-side (dark today) and returns ONLY
 *     the PublicAppDetail allowlist.
 */
export const getServerSideProps = createServerSideProps({
  useSession: true,
  // Flag gate FIRST and ONLY (no session→login redirect): the detail page renders
  // for a session-less request BEHIND the flag (dark today; lit at segment-widen).
  resolver: async ({ features }) => resolveAppsPageAccess({ features }),
});

function slotLabel(slotId?: string): string {
  switch (slotId) {
    case 'model.sidebar_top':
      return 'Model sidebar (top)';
    case 'model.below_images':
      return 'Below model images';
    case 'model.actions_extra':
      return 'Model action buttons';
    default:
      return slotId ?? 'Unknown slot';
  }
}

export default function AppDetailPage() {
  const features = useFeatureFlags();
  const currentUser = useCurrentUser();
  const router = useRouter();
  const appBlockId = typeof router.query.appBlockId === 'string' ? router.query.appBlockId : '';

  // Anon-CAPABLE public read path. Fires for any viewer the appBlocks flag
  // grants (mods-only today). Returns ONLY the PublicAppDetail allowlist; a
  // missing / non-approved id 404s server-side.
  const { data, isLoading, error } = trpc.blocks.getAppDetail.useQuery(
    { appBlockId },
    { enabled: !!features.appBlocks && !!appBlockId, retry: false }
  );

  // Per-user subscription lookup so the CTA shows Manage vs Install. Guarded on
  // a logged-in user — the dark anon read path must not fire this protected
  // procedure (it 401s for anon). `features.appBlocks` alone isn't enough behind
  // a widened segment.
  const { data: mySubs } = trpc.blocks.listMySubscriptions.useQuery(undefined, {
    enabled: !!features.appBlocks && !!currentUser,
  });
  const existingByScope = useMemo(() => {
    const map: Partial<Record<SubscriptionScope, SubscriptionRecord>> = {};
    for (const sub of mySubs ?? []) {
      if (sub.appBlockId === appBlockId) map[sub.scope] = sub;
    }
    return map;
  }, [mySubs, appBlockId]);
  const alreadySubscribed = Object.keys(existingByScope).length > 0;

  if (!features.appBlocks) return <NotFound />;

  const detail = data as PublicAppDetail | undefined;
  const name = detail?.manifest.name ?? detail?.blockId ?? appBlockId;
  const description = detail?.manifest.description ?? '';
  const slots = detail?.manifest.targets?.map((t) => t.slotId).filter(Boolean) ?? [];
  const scopes = detail?.scopes ?? [];

  function handleInstall() {
    if (!detail) return;
    // Reuse the E1 install path. PublicAppDetail is a superset of the listing
    // shape, so build the AvailableBlock the settings modal expects. The modal
    // sources settings/scopes from the authenticated getInstallConfig itself.
    const block: AvailableBlock = {
      id: detail.id,
      blockId: detail.blockId,
      appId: detail.appId,
      appName: detail.appName,
      manifest: detail.manifest,
      installCount: detail.installCount,
      // E3 marketplace-card fields — unused by the settings modal (it sources
      // scopes from the authenticated getInstallConfig), so safe placeholders.
      category: null,
      scopesSummary: [],
    };
    openAppSettingsModal({ block, existingByScope });
  }

  // The query 404s (NOT_FOUND) for a missing / non-approved app. retry:false so
  // the page settles into a NotFound rather than spinning on a hard 404.
  if (error) return <NotFound />;

  return (
    <>
      {/*
        Per-app OG/meta (title + description from the public manifest). deIndex
        STAYS ON until launch (the page is mod-only today; don't let crawlers
        index it). Dropping deIndex is a deliberate launch-time step.
      */}
      <Meta
        title={`${name} — Civitai Apps`}
        description={description || `${name} on the Civitai App Blocks marketplace.`}
        deIndex
      />
      <Container size="md" py="md">
        <Stack gap="lg">
          <Anchor component={Link} href="/apps" size="sm">
            <Group gap={4}>
              <IconArrowLeft size={14} />
              Back to marketplace
            </Group>
          </Anchor>

          {isLoading ? (
            <Center py="xl">
              <Loader />
            </Center>
          ) : !detail ? (
            <NotFound />
          ) : (
            <Stack gap="lg">
              {/* Header */}
              <Group justify="space-between" align="flex-start" wrap="nowrap">
                <Stack gap={4}>
                  <Title order={2}>{name}</Title>
                  <Text c="dimmed" size="sm">
                    by {detail.appName ?? detail.appId}
                  </Text>
                  <Group gap="xs" mt={4}>
                    <Badge variant="light" color="gray" size="sm">
                      {detail.installCount.toLocaleString()} install
                      {detail.installCount === 1 ? '' : 's'}
                    </Badge>
                    {detail.version && (
                      <Badge variant="light" color="gray" size="sm">
                        v{detail.version}
                      </Badge>
                    )}
                    {detail.contentRating && (
                      <Badge variant="light" color="gray" size="sm">
                        {detail.contentRating}
                      </Badge>
                    )}
                  </Group>
                </Stack>
                <Group gap="xs" wrap="nowrap">
                  <Button
                    component="a"
                    href={detail.liveUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    variant="default"
                    leftSection={<IconExternalLink size={16} />}
                  >
                    Open live
                  </Button>
                  {/*
                    Install CTA — reuses the E1 sign-in-gated path: anon → the
                    LoginModal (via LoginRedirect); logged-in → the install/
                    settings modal. Dark today (page is mod-gated).
                  */}
                  <LoginRedirect reason="perform-action">
                    <Button
                      leftSection={
                        alreadySubscribed ? (
                          <IconSettings size={16} />
                        ) : (
                          <IconPlugConnected size={16} />
                        )
                      }
                      variant={alreadySubscribed ? 'default' : 'filled'}
                      onClick={handleInstall}
                    >
                      {alreadySubscribed ? 'Manage' : 'Install'}
                    </Button>
                  </LoginRedirect>
                </Group>
              </Group>

              {description && (
                <Text size="sm" style={{ whiteSpace: 'pre-wrap' }}>
                  {description}
                </Text>
              )}

              <Divider />

              {/* Live preview — a sandboxed iframe of the already-public
                  standalone block origin (detail.liveUrl). See the tradeoff
                  note in the page docstring / PR: this avoids introducing any
                  new anon-token or scope-exposure path that an in-page block
                  host (model-context + minted block JWT) would require. */}
              <Stack gap="xs">
                <Title order={4}>Live preview</Title>
                <Card withBorder padding={0} radius="md" style={{ overflow: 'hidden' }}>
                  <iframe
                    src={detail.liveUrl}
                    title={`${name} live preview`}
                    // Minimal sandbox: allow the block's own scripts + same-origin
                    // (it's served from its own subdomain), nothing else. No
                    // top-navigation, no popups, no form submission.
                    sandbox="allow-scripts allow-same-origin"
                    referrerPolicy="no-referrer"
                    loading="lazy"
                    style={{
                      width: '100%',
                      height: 420,
                      border: 0,
                      display: 'block',
                    }}
                  />
                </Card>
                <Text size="xs" c="dimmed">
                  Preview of the standalone block at{' '}
                  <Anchor href={detail.liveUrl} target="_blank" rel="noopener noreferrer">
                    {detail.liveUrl.replace(/^https?:\/\//, '')}
                  </Anchor>
                  . The live block on a model page runs with your granted permissions; this
                  standalone preview does not.
                </Text>
              </Stack>

              <Divider />

              {/* Permissions disclosure — the approved scopes, rendered via
                  SCOPE_DESCRIPTIONS (closes the H3 "no permission disclosure at
                  decision time" gap at the marketplace level). */}
              <Stack gap="xs">
                <Group gap="xs">
                  <ThemeIcon variant="light" color="blue" size="sm" radius="xl">
                    <IconShieldCheck size={14} />
                  </ThemeIcon>
                  <Title order={4}>This app can…</Title>
                </Group>
                {scopes.length === 0 ? (
                  <Text size="sm" c="dimmed">
                    This app does not request any permissions.
                  </Text>
                ) : (
                  <List
                    spacing="xs"
                    size="sm"
                    icon={
                      <ThemeIcon variant="light" color="gray" size="sm" radius="xl">
                        <IconLock size={12} />
                      </ThemeIcon>
                    }
                  >
                    {scopes.map((scope) => (
                      <List.Item key={scope}>
                        {SCOPE_DESCRIPTIONS[scope] ?? scope}
                      </List.Item>
                    ))}
                  </List>
                )}
              </Stack>

              <Divider />

              {/* Target slots — where the block mounts, via SLOT_DESCRIPTIONS. */}
              <Stack gap="xs">
                <Title order={4}>Appears in</Title>
                {slots.length === 0 ? (
                  <Text size="sm" c="dimmed">
                    This app declares no target slots.
                  </Text>
                ) : (
                  <List spacing="xs" size="sm">
                    {slots.map((slotId) => (
                      <List.Item key={slotId}>
                        <Text component="span" fw={500}>
                          {slotLabel(slotId)}
                        </Text>
                        {SLOT_DESCRIPTIONS[slotId as string] && (
                          <Text component="span" c="dimmed">
                            {' '}
                            — {SLOT_DESCRIPTIONS[slotId as string]}
                          </Text>
                        )}
                      </List.Item>
                    ))}
                  </List>
                )}
              </Stack>
            </Stack>
          )}
        </Stack>
      </Container>
    </>
  );
}
