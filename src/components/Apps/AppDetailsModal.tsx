import {
  Anchor,
  Avatar,
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
import Link from 'next/link';
import { getEdgeUrl } from '~/client-utils/cf-images-utils';
import { AppListingDescription } from '~/components/Apps/AppListingDescription';
import { getAppDetailAuthor } from '~/components/Apps/appDetailAuthorView';
import { useFeatureFlags } from '~/providers/FeatureFlagsProvider';
import type { AvailableBlock, PublicAppDetail } from '~/server/schema/blocks/subscription.schema';
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
 *   - Scopes — the permission disclosure, moved off the card face.
 *
 * Data sources (all the anon-safe public allowlist — no private manifest data):
 *   - title / description / screenshots / scopes / version → `blocks.getAppDetail`
 *     (PublicAppDetail). Title falls back to the listing `block` so the header
 *     renders before the detail query resolves.
 *   - author → `PublicAppDetail.owner`, the app's REAL owner chip, via the pure
 *     `getAppDetailAuthor`. 🔴 NEVER `appName`/`appId` — see that module. There
 *     is no listing-row fallback because `AvailableBlock` carries no owner, so
 *     the line is simply absent until the detail query resolves.
 */
export function AppDetailsModal({ opened, onClose, block }: AppDetailsModalProps) {
  const features = useFeatureFlags();
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

  const detail = data as PublicAppDetail | undefined;
  // Did the detail query actually RESOLVE (vs still loading / failed)? This is
  // the load-bearing distinction for the disclosure copy + the aggregates: we
  // only make a definitive statement ("does not request any permissions")
  // once the public detail genuinely resolved.
  const detailLoaded = detail !== undefined;
  // Title/author render from the listing row immediately; the detail query
  // enriches them (and is the only source for screenshots/scopes/version).
  const name = detail?.manifest.name ?? block.manifest.name ?? block.blockId;
  // AUTHOR — the app's REAL owner, never `appName`/`appId`. `appName` is the
  // OAuth CLIENT's name, and for every approved block in prod it equals the
  // app's own TITLE (verified: `appblk-gen-matrix` → OauthClient name "Gen
  // Matrix", real owner `zachlowdenzx`), so `by {appName}` rendered the app's
  // own title in the author slot and `?? appId` fell back to an opaque internal
  // id. The whole decision — including "no username → render NOTHING rather than
  // a wrong name" — lives in the pure `getAppDetailAuthor`.
  //
  // The owner only exists on the resolved `PublicAppDetail`; the listing row
  // (`AvailableBlock`) carries no owner at all, so while the detail query is in
  // flight there is simply no attribution line. That is deliberate: a blank
  // beats a wrong name for the time the query takes.
  const author = getAppDetailAuthor(detail);
  const description = detail?.manifest.description ?? block.manifest.description ?? '';
  const screenshots = detail?.screenshots ?? [];
  const scopes = detail?.scopes ?? [];
  // Off-site (external-link) app — PURE EXTERNAL LINK. Prefer the listing row's
  // `externalUrl` (renders immediately) and fall back to the resolved detail.
  // When set, the modal surfaces the external URL as the primary CTA and HIDES
  // the scopes disclosure (an external app has none).
  const externalUrl = block.externalUrl ?? detail?.externalUrl ?? null;
  const isExternal = Boolean(externalUrl);
  return (
    <Modal opened={opened} onClose={onClose} title={name} size="lg" radius="md">
      <Stack gap="lg">
        {/* Header — title (modal title) + author + description. */}
        <Stack gap={4}>
          {/* Real-owner chip, linked to the profile — mirrors the store detail's
              `CreatorChip`. Null-safe: no resolvable owner → no line at all. */}
          {author && (
            <Anchor
              component={Link}
              href={author.href}
              underline="hover"
              c="dimmed"
              data-testid="app-detail-author"
            >
              <Group gap={6} wrap="nowrap">
                <Avatar
                  src={author.image ? getEdgeUrl(author.image, { width: 64 }) : undefined}
                  alt=""
                  radius="xl"
                  size={20}
                >
                  {author.username.charAt(0).toUpperCase()}
                </Avatar>
                <Text c="dimmed" size="sm">
                  by {author.username}
                </Text>
              </Group>
            </Anchor>
          )}
          {/* Off-site (external-link) app: the external URL is the PRIMARY CTA
              (open in a new tab). For an on-platform app keep the standalone
              "Open live" affordance. */}
          {isExternal ? (
            <Anchor href={externalUrl!} target="_blank" rel="noopener noreferrer" size="xs">
              <Group gap={4}>
                <IconExternalLink size={12} />
                Open external site
              </Group>
            </Anchor>
          ) : (
            detail?.liveUrl && (
              <Anchor href={detail.liveUrl} target="_blank" rel="noopener noreferrer" size="xs">
                <Group gap={4}>
                  <IconExternalLink size={12} />
                  Open live
                </Group>
              </Anchor>
            )
          )}
        </Stack>

        {/* Markdown, via the shared renderer (`appListingDescriptionText.ts` holds the
            rule). Was `pre-wrap` plain text, which disagreed with the listing
            detail body's markdown rendering of the same stored string. */}
        {description && <AppListingDescription description={description} />}

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

        {/* Off-site (external-link) app: NO scopes disclosure — an external app
            requests no permissions and runs entirely off-platform. The whole
            scopes section (and its divider) is suppressed. */}
        {!isExternal && <Divider />}

        {/* Scopes — the permission disclosure, MOVED off the card face into the
            modal (2026-06 UX pass). Sourced from the app's APPROVED scopes
            (PublicAppDetail.scopes). Hidden entirely for an external app.

            DISCLOSURE CORRECTNESS (audit M1): the definitive "does not request
            any permissions" copy renders ONLY when the detail genuinely RESOLVED
            (detailLoaded) with an empty scope list. While LOADING we show a
            spinner; on ERROR we show an explicit "couldn't load" state — never
            the reassuring "no permissions" line, which would be a misleading
            security-relevant claim about an app whose scopes we never actually
            read. */}
        {!isExternal && (
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
        )}
      </Stack>
    </Modal>
  );
}
