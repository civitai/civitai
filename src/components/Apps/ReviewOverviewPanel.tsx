import { Badge, Card, Grid, Group, Spoiler, Stack, Text } from '@mantine/core';
import { IconAlertTriangle, IconKey } from '@tabler/icons-react';
import {
  ManifestScopeRow,
  REVIEW_PREVIEW_OVERVIEW_HEIGHT,
  ReviewAgentSection,
  ReviewPreviewSection,
  type OnsiteReviewSelection,
} from '~/components/Apps/OnsiteReviewModal';
import { ReviewConsoleSummary } from '~/components/Apps/ReviewConsole';
import { ReviewListingMediaLive } from '~/components/Apps/ReviewListingMediaLive';
import { groupBlockScopes } from '~/components/Apps/listingPermissions';
import { manifestScopes } from '~/components/Apps/reviewQueueSignals';
import { appDisplayName } from '~/shared/utils/app-display-name';

/**
 * The review page's OVERVIEW tab — the default — composing the decision signals for one
 * submission on ONE screen: what the app says it is (tagline + description, from the manifest),
 * the agentic review's findings, the requested permissions (sensitive ones with the developer's
 * justification), the running app, and the store art.
 *
 * 🔴 EVERY PIECE IS THE SHARED ONE. The AI finding counts are `ReviewAgentSection variant="summary"` (its
 * gate included), the sensitive rows are `ManifestScopeRow`, the preview is
 * `ReviewPreviewSection`, the art is `ReviewListingMedia`. The other tabs are the evidence
 * behind each signal; nothing here is a second implementation of them.
 *
 * Layout: the description across the top (a long one folds behind "Show more"), then two
 * columns from `md` — signals left, the app right. One column below `md`, app first after the
 * AI findings.
 */
export function ReviewOverviewPanel({
  selection,
  onOpenTab,
}: {
  selection: NonNullable<OnsiteReviewSelection>;
  /**
   * Switch the page to another tab (the AI findings card's "Full report", "All permissions",
   * the console line's "Open console").
   */
  onOpenTab?: (tab: 'agent' | 'permissions' | 'console') => void;
}) {
  const { request } = selection;
  const manifest = (request.manifest ?? {}) as Record<string, unknown>;

  return (
    // A labelled region, not only a testid: production builds strip `data-testid`, and the
    // preview e2e (which runs against a production build) finds the Overview by this name.
    <Grid
      gutter="md"
      data-testid="apps-review-overview"
      role="region"
      aria-label="Submission overview"
    >
      <Grid.Col span={12}>
        <ManifestDescription manifest={manifest} />
      </Grid.Col>
      <Grid.Col span={{ base: 12, md: 5 }}>
        <Stack gap="md">
          <ReviewAgentSection
            selection={selection}
            variant="summary"
            onOpenReport={onOpenTab ? () => onOpenTab('agent') : undefined}
          />
          <PermissionSummary
            manifest={manifest}
            onOpenAll={onOpenTab && (() => onOpenTab('permissions'))}
          />
          <ReviewListingMediaLive
            // The re-rate pickers and live levels (moderators): see `ReviewListingMediaLive`.
            listingId={request.appListingId ?? null}
            approveListingId={request.approveRating?.listingId ?? null}
            slug={request.slug}
            name={appDisplayName(request.manifest, request.slug)}
            iconUrl={request.iconUrl ?? null}
            coverUrl={request.coverUrl ?? null}
            reviewMedia={request.reviewMedia ?? null}
            rating={typeof manifest.contentRating === 'string' ? manifest.contentRating : null}
          />
        </Stack>
      </Grid.Col>
      <Grid.Col span={{ base: 12, md: 7 }}>
        <Stack gap="md">
          {/* The running app's error count, and a crash's reason, without opening the Console.
              Renders nothing until the preview reports one. */}
          <ReviewConsoleSummary onOpen={onOpenTab && (() => onOpenTab('console'))} />
          <ReviewPreviewSection
            selection={selection}
            frameHeight={REVIEW_PREVIEW_OVERVIEW_HEIGHT}
          />
        </Stack>
      </Grid.Col>
    </Grid>
  );
}

/**
 * The tagline and description the developer wrote — the store's own words for the app, which go
 * live on approve. Rendered as text (never markdown or HTML): the manifest is author-controlled.
 */
function ManifestDescription({ manifest }: { manifest: Record<string, unknown> }) {
  const tagline = typeof manifest.tagline === 'string' ? manifest.tagline.trim() : '';
  const description = typeof manifest.description === 'string' ? manifest.description.trim() : '';
  return (
    <Card withBorder p="sm" data-testid="apps-review-overview-description">
      <Stack gap={4}>
        {tagline && (
          <Text size="sm" fw={600} data-testid="apps-review-overview-tagline">
            {tagline}
          </Text>
        )}
        {description ? (
          <Spoiler maxHeight={96} showLabel="Show more" hideLabel="Show less">
            <Text
              size="sm"
              style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}
              data-testid="apps-review-overview-description-text"
            >
              {description}
            </Text>
          </Spoiler>
        ) : (
          <Text size="xs" c="dimmed" fs="italic">
            {tagline
              ? 'No description in the manifest.'
              : 'No tagline or description in the manifest.'}
          </Text>
        )}
      </Stack>
    </Card>
  );
}

/**
 * The permissions at a glance: every SENSITIVE scope as its full row (scope, what it allows,
 * and the developer's "Why"), then the ordinary scopes as chips. The full card, with every
 * description, is the Permissions tab.
 */
function PermissionSummary({
  manifest,
  onOpenAll,
}: {
  manifest: Record<string, unknown>;
  onOpenAll?: () => void;
}) {
  const scopes = manifestScopes(manifest);
  const { sensitive, other } = groupBlockScopes(scopes);
  const justifications =
    manifest.scopeJustifications &&
    typeof manifest.scopeJustifications === 'object' &&
    !Array.isArray(manifest.scopeJustifications)
      ? (manifest.scopeJustifications as Record<string, unknown>)
      : {};
  return (
    <Card withBorder p="sm" data-testid="apps-review-overview-permissions">
      <Stack gap={8}>
        <Group justify="space-between" wrap="nowrap">
          <Group gap={6} wrap="nowrap">
            {sensitive.length > 0 ? (
              <IconAlertTriangle size={16} color="var(--mantine-color-orange-6)" />
            ) : (
              <IconKey size={16} />
            )}
            <Text size="sm" fw={600}>
              Permissions
            </Text>
            <Badge
              variant="light"
              color={sensitive.length > 0 ? 'orange' : 'gray'}
              data-testid="apps-review-overview-sensitive-count"
            >
              {sensitive.length} sensitive
            </Badge>
          </Group>
          {onOpenAll && scopes.length > 0 && (
            <Text
              component="button"
              type="button"
              size="xs"
              c="blue"
              onClick={onOpenAll}
              style={{ background: 'none', border: 0, cursor: 'pointer', padding: 0 }}
            >
              All details
            </Text>
          )}
        </Group>
        {scopes.length === 0 ? (
          <Text size="xs" c="dimmed" fs="italic">
            No permissions requested.
          </Text>
        ) : (
          <>
            {sensitive.map((s) => (
              <ManifestScopeRow key={s} scope={s} justifications={justifications} />
            ))}
            {other.length > 0 && (
              <Group gap={4} data-testid="apps-review-overview-other-scopes">
                {other.map((s) => (
                  <Badge
                    key={s}
                    variant="light"
                    color="blue"
                    size="sm"
                    style={{ fontFamily: 'ui-monospace, monospace', textTransform: 'none' }}
                  >
                    {s}
                  </Badge>
                ))}
              </Group>
            )}
          </>
        )}
      </Stack>
    </Card>
  );
}
