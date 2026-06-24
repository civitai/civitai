import {
  Anchor,
  Badge,
  Card,
  Center,
  Divider,
  Group,
  List,
  Loader,
  Modal,
  SimpleGrid,
  Stack,
  Text,
  ThemeIcon,
  Title,
} from '@mantine/core';
import { IconExternalLink, IconLock, IconShieldCheck } from '@tabler/icons-react';
import { useMemo } from 'react';
import { AppBlockReviews } from '~/components/Apps/AppBlockReviews';
import { useCurrentUser } from '~/hooks/useCurrentUser';
import { useFeatureFlags } from '~/providers/FeatureFlagsProvider';
import type {
  AvailableBlock,
  PublicAppDetail,
  SubscriptionRecord,
} from '~/server/schema/blocks/subscription.schema';
import { SCOPE_DESCRIPTIONS } from '~/server/services/blocks/scope-descriptions.constants';
import { trpc } from '~/utils/trpc';

export interface AppDetailsModalProps {
  /** Controlled open state. The card owns the lifecycle (local useState). */
  opened: boolean;
  onClose: () => void;
  /**
   * The marketplace listing row for this app. Drives the IMMEDIATE header
   * render (title + author + the card-level review aggregate) so the modal
   * never shows an empty header while the detail query is in flight. The
   * richer fields (screenshots, full approved scopes, version) come from the
   * `getAppDetail` query below — the same anon-capable public read path the
   * /apps/<id> detail page uses.
   */
  block: AvailableBlock;
}

/** Human label for a scope id, falling back to the raw id for an unknown scope
 *  so a newly-added scope ships without breaking the disclosure list. */
function scopeLabel(scope: string): string {
  return SCOPE_DESCRIPTIONS[scope] ?? scope;
}

/**
 * App Blocks marketplace DETAILS modal.
 *
 * Opened from the card's "View details" button (the universal details
 * affordance — see AppBlockCard). Consolidates the richer-but-secondary app
 * info that was moved OFF the card face in the 2026-06 UX pass:
 *   - Header: title, author, and (when present) the publisher screenshot
 *     gallery + description.
 *   - Recent reviews — reuses the existing <AppBlockReviews> component/queries
 *     (summary + a few recent rows + the gated write form). Not rebuilt.
 *   - Scopes — the permission disclosure, moved off the card face.
 *
 * Data sources (all the anon-safe public allowlist — no private manifest data):
 *   - title / description / screenshots / scopes / version → `blocks.getAppDetail`
 *     (PublicAppDetail). Title/author also fall back to the listing `block` so
 *     the header renders before the detail query resolves.
 *   - author → the app owner (`block.appName` / `detail.appName`).
 *   - reviews → the existing block-reviews queries inside <AppBlockReviews>.
 *
 * The modal fetches its own subscriptions (mirroring the detail page) so the
 * reviews write-form gate works without threading new props through the
 * marketplace grid — it is fully self-contained.
 */
export function AppDetailsModal({ opened, onClose, block }: AppDetailsModalProps) {
  const features = useFeatureFlags();
  const currentUser = useCurrentUser();
  const appBlockId = block.id;

  // Anon-capable public read path — only fires while the modal is open (and the
  // appBlocks flag is granted). Returns ONLY the PublicAppDetail allowlist.
  // `retry: false` → a failure surfaces immediately as `isError` (we render an
  // explicit error state for the detail-only sections rather than silently
  // falling through to "no permissions" — that would be a misleading
  // security-relevant disclosure; see the scopes block below).
  const { data, isLoading, isError } = trpc.blocks.getAppDetail.useQuery(
    { appBlockId },
    { enabled: opened && !!features.appBlocks && !!appBlockId, retry: false }
  );

  // Per-user subscriptions feed the reviews write-form gate (an enabled install
  // is required to review, mirroring the server gate). Guarded on a signed-in
  // user — the protected proc 401s for anon. Only fires while open.
  const { data: mySubs } = trpc.blocks.listMySubscriptions.useQuery(undefined, {
    enabled: opened && !!features.appBlocks && !!currentUser,
  });
  const mySubsForApp = useMemo<SubscriptionRecord[]>(
    () => (mySubs ?? []).filter((sub) => sub.appBlockId === appBlockId),
    [mySubs, appBlockId]
  );

  const detail = data as PublicAppDetail | undefined;
  // Did the detail query actually RESOLVE (vs still loading / failed)? This is
  // the load-bearing distinction for the disclosure copy + the aggregates: we
  // only make a definitive statement ("does not request any permissions",
  // resolved avgRating/reviewCount) once the public detail genuinely resolved.
  const detailLoaded = detail !== undefined;
  // Title/author render from the listing row immediately; the detail query
  // enriches them (and is the only source for screenshots/scopes/version).
  const name = detail?.manifest.name ?? block.manifest.name ?? block.blockId;
  const author = detail?.appName ?? block.appName ?? block.appId;
  const description = detail?.manifest.description ?? block.manifest.description ?? '';
  const screenshots = detail?.screenshots ?? [];
  const scopes = detail?.scopes ?? [];
  // L2: once the detail resolved, the aggregate is authoritative — prefer it
  // DIRECTLY (a legit `null` means "no rating", not "fall back to the stale
  // listing value"). Only use the listing `block` aggregate WHILE loading
  // (detail === undefined). `??` would wrongly fall through on a resolved null.
  const avgRating = detailLoaded ? detail.avgRating : block.avgRating;
  const reviewCount = detailLoaded ? detail.reviewCount : block.reviewCount;

  return (
    <Modal opened={opened} onClose={onClose} title={name} size="lg" radius="md">
      <Stack gap="lg">
        {/* Header — title (modal title) + author + description. */}
        <Stack gap={4}>
          <Text c="dimmed" size="sm">
            by {author}
          </Text>
          {detail?.liveUrl && (
            <Anchor
              href={detail.liveUrl}
              target="_blank"
              rel="noopener noreferrer"
              size="xs"
            >
              <Group gap={4}>
                <IconExternalLink size={12} />
                Open live
              </Group>
            </Anchor>
          )}
        </Stack>

        {description && (
          <Text size="sm" style={{ whiteSpace: 'pre-wrap' }}>
            {description}
          </Text>
        )}

        {/* Detail-load failure (audit M1): when the public-detail query errors
            we can't say anything definitive about screenshots OR scopes, so
            surface ONE explicit error banner here (the scopes block below shows
            its own inline error too) rather than rendering a "no screenshots /
            no permissions" view that looks like a deliberate, reassuring
            statement about the app. */}
        {isError && (
          <Text size="sm" c="red">
            Couldn&apos;t load full details — try again.
          </Text>
        )}

        {/* Screenshots — publisher gallery from the public allowlist (gated app
            route URLs, magic-byte-validated + mod-reviewed at approval). Hidden
            entirely when the app shipped none (graceful absence). On detail-load
            error `screenshots` is empty AND `isError` shows the banner above, so
            we don't imply "this app has no screenshots". */}
        {screenshots.length > 0 && (
          <Stack gap="xs">
            <Title order={5}>Screenshots</Title>
            <SimpleGrid cols={{ base: 1, sm: 2 }} spacing="md">
              {screenshots.map((shot) => (
                <Card
                  key={shot.index}
                  withBorder
                  padding={0}
                  radius="md"
                  style={{ overflow: 'hidden' }}
                >
                  {/* Plain <img> from our own gated route (not a Next/Image
                      configured domain). */}
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img
                    src={shot.url}
                    alt={`${name} screenshot ${shot.index + 1}`}
                    loading="lazy"
                    style={{ width: '100%', height: 'auto', display: 'block' }}
                  />
                </Card>
              ))}
            </SimpleGrid>
          </Stack>
        )}

        {/* A small in-flight hint while the detail query resolves the richer
            fields (screenshots/scopes). Title/author/description already show. */}
        {isLoading && (
          <Center py="sm">
            <Loader size="sm" />
          </Center>
        )}

        <Divider />

        {/* Scopes — the permission disclosure, MOVED off the card face into the
            modal (2026-06 UX pass). Sourced from the app's APPROVED scopes
            (PublicAppDetail.scopes).

            DISCLOSURE CORRECTNESS (audit M1): the definitive "does not request
            any permissions" copy renders ONLY when the detail genuinely RESOLVED
            (detailLoaded) with an empty scope list. While LOADING we show a
            spinner; on ERROR we show an explicit "couldn't load" state — never
            the reassuring "no permissions" line, which would be a misleading
            security-relevant claim about an app whose scopes we never actually
            read. */}
        <Stack gap="xs">
          <Group gap="xs">
            <ThemeIcon variant="light" color="blue" size="sm" radius="xl">
              <IconShieldCheck size={14} />
            </ThemeIcon>
            <Title order={5}>This app can…</Title>
          </Group>
          {isError ? (
            <Text size="sm" c="red">
              Couldn&apos;t load full details — try again.
            </Text>
          ) : !detailLoaded ? (
            <Center py="xs">
              <Loader size="xs" />
            </Center>
          ) : scopes.length === 0 ? (
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
                  <Group gap="xs" wrap="nowrap" align="center">
                    <Badge variant="outline" color="gray" size="xs">
                      {scope}
                    </Badge>
                    <Text component="span" size="sm">
                      {scopeLabel(scope)}
                    </Text>
                  </Group>
                </List.Item>
              ))}
            </List>
          )}
        </Stack>

        <Divider />

        {/* Recent reviews — REUSES the existing reviews component + queries
            (summary + a few recent rows + the gated write form). The aggregate
            (avgRating / reviewCount) comes from the listing row (kept fresh by
            getAppDetail invalidation inside the component). */}
        <AppBlockReviews
          appBlockId={appBlockId}
          avgRating={avgRating}
          reviewCount={reviewCount}
          subscriptions={mySubsForApp}
        />
      </Stack>
    </Modal>
  );
}
