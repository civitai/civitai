import { Badge, Button, Card, Code, Group, Table, Text } from '@mantine/core';
import { IconExternalLink, IconWindow, IconX } from '@tabler/icons-react';
import { ModQueryError, isModAuthzError } from '~/components/Apps/ModQuerySurface';
import { useFeatureFlags } from '~/providers/FeatureFlagsProvider';
import { showErrorNotification, showSuccessNotification } from '~/utils/notifications';
import { trpc } from '~/utils/trpc';

/**
 * MOD REVIEW SANDBOX — global "Active previews (N / cap)" panel. Extracted from
 * `src/pages/apps/review.tsx` (mirrors the #3163 `OnsiteReviewModal` extraction)
 * so it can be mounted in a browser (jsdom) test WITHOUT pulling the page's
 * `getServerSideProps`/`createServerSideProps` tRPC-server graph. `review.tsx`
 * imports it back and renders it exactly as before (zero behaviour change).
 *
 * Review previews are capped globally across all mods (each holds a review
 * Deployment + Service + IngressRoute), so this surfaces every active preview +
 * a per-row Tear down so a mod can free a slot, plus (for a LIVE preview) an
 * "Open full-page preview" link to the same-origin internal review route the
 * per-request modal uses. Polls every 30s so the count stays fresh. Dark behind
 * the same mod-only review-sandbox flag as the per-request panel: when off,
 * listActivePreviews throws UNAUTHORIZED and this renders nothing.
 *
 * Everything here is server-graph-free: `ModQuerySurface` (pure Mantine),
 * `useFeatureFlags`, `~/utils/notifications`, and `~/utils/trpc` are the same
 * imports the browser-tested `OnsiteReviewModal` uses.
 */

// Compact relative age ("just now" / "5m" / "2h" / "3d") for the active-preview
// panel — the exact timestamp isn't useful there, freshness is.
export function formatAge(d: string | Date | null | undefined): string {
  if (!d) return '—';
  const date = typeof d === 'string' ? new Date(d) : d;
  const ms = Date.now() - date.getTime();
  if (!Number.isFinite(ms) || ms < 0) return '—';
  const s = Math.floor(ms / 1000);
  if (s < 60) return 'just now';
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h`;
  return `${Math.floor(h / 24)}d`;
}

export function ActivePreviewsPanel() {
  const features = useFeatureFlags();
  const utils = trpc.useUtils();

  const query = trpc.blocks.listActivePreviews.useQuery(undefined, {
    enabled: !!features?.appBlocks,
    retry: false,
    // Poll every 30s to keep the count fresh WHILE it's working, but stop once the
    // query errors — when the review-sandbox flag is off (appBlocks on, sandbox
    // flag off) the server throws UNAUTHORIZED, and a fixed interval would re-fire
    // that guaranteed-dead request forever. (react-query v5: the callback gets the
    // Query; teardown mutations still invalidate → refetch, so a resume path exists.)
    refetchInterval: (q) => (q.state.error ? false : 30000),
  });

  const teardownMut = trpc.blocks.teardownPreview.useMutation({
    onSuccess: async (_res, vars) => {
      showSuccessNotification({ message: 'Review preview torn down.' });
      await Promise.all([
        utils.blocks.listActivePreviews.invalidate(),
        utils.blocks.getReviewStatus.invalidate({ publishRequestId: vars.publishRequestId }),
      ]);
    },
    onError: (e) => {
      showErrorNotification({ title: 'Could not tear down preview', error: new Error(e.message) });
    },
  });

  // Flag off / not enabled or nothing active → render nothing so the panel stays
  // unobtrusive when the sandbox isn't in use. An AUTHZ error (sandbox flag off →
  // UNAUTHORIZED) is that intended silent case; a TRANSIENT error surfaces a retry
  // instead of silently disappearing.
  const cap = query.data?.cap ?? 0;
  const active = query.data?.active ?? [];
  if (!features?.appBlocks) return null;
  if (query.error) {
    if (isModAuthzError(query.error)) return null;
    return (
      <ModQueryError
        error={query.error}
        onRetry={() => query.refetch()}
        isRetrying={query.isFetching}
        title="Couldn’t load active previews"
        testId="apps-active-previews-error"
        mt="md"
      />
    );
  }
  if (active.length === 0) return null;

  const atCap = cap > 0 && active.length >= cap;

  return (
    <Card withBorder p="md" mb="md">
      <Group gap={6} mb="xs">
        <IconWindow size={16} />
        <Text size="sm" fw={600}>
          Active previews
        </Text>
        <Badge size="sm" variant="light" color={atCap ? 'red' : 'blue'}>
          {active.length} / {cap}
        </Badge>
        {atCap && (
          <Text size="xs" c="red">
            Cap reached — tear one down to start another.
          </Text>
        )}
      </Group>
      <Table verticalSpacing="xs" horizontalSpacing="md">
        <Table.Thead>
          <Table.Tr>
            <Table.Th>App</Table.Th>
            <Table.Th>Version</Table.Th>
            <Table.Th>State</Table.Th>
            <Table.Th>Age</Table.Th>
            <Table.Th />
          </Table.Tr>
        </Table.Thead>
        <Table.Tbody>
          {active.map((p) => (
            <Table.Tr key={p.publishRequestId}>
              <Table.Td>
                <Code>{p.slug}</Code>
              </Table.Td>
              <Table.Td>
                <Code>{p.version}</Code>
              </Table.Td>
              <Table.Td>
                <Badge
                  size="sm"
                  variant="light"
                  color={p.state === 'preview-live' ? 'green' : 'blue'}
                >
                  {p.state.replace('preview-', '')}
                </Badge>
              </Table.Td>
              <Table.Td>
                <Text size="xs" c="dimmed">
                  {formatAge(p.updatedAt)}
                </Text>
              </Table.Td>
              <Table.Td>
                <Group gap="xs">
                  {/* Only a LIVE preview is openable — a building/deploying/failed
                      preview's full-page route shows a non-live message, so we
                      don't offer "Open" until it's live. Links by publishRequestId
                      to the SAME same-origin internal route the per-request modal's
                      ReviewPreviewPanel uses (top-level, new tab) — NOT the raw
                      `?mr=` host URL, which hangs on "Connecting to host" opened
                      top-level (it has no host bridge). */}
                  {p.state === 'preview-live' && (
                    <Button
                      size="xs"
                      variant="default"
                      component="a"
                      href={`/apps/review/preview/${p.publishRequestId}`}
                      target="_blank"
                      rel="noopener"
                      rightSection={<IconExternalLink size={12} />}
                    >
                      Open full-page preview ↗
                    </Button>
                  )}
                  <Button
                    size="xs"
                    variant="light"
                    color="red"
                    leftSection={<IconX size={12} />}
                    loading={
                      teardownMut.isPending &&
                      teardownMut.variables?.publishRequestId === p.publishRequestId
                    }
                    onClick={() => teardownMut.mutate({ publishRequestId: p.publishRequestId })}
                  >
                    Tear down
                  </Button>
                </Group>
              </Table.Td>
            </Table.Tr>
          ))}
        </Table.Tbody>
      </Table>
    </Card>
  );
}
