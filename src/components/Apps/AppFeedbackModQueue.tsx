import {
  Anchor,
  Badge,
  Button,
  Center,
  Checkbox,
  Group,
  Loader,
  Modal,
  Paper,
  Select,
  Stack,
  Text,
} from '@mantine/core';
import { useDebouncedValue } from '@mantine/hooks';
import Link from 'next/link';
import { useRouter } from 'next/router';
import { useMemo, useState, type ReactNode } from 'react';
import { ModQueryError, isModAuthzError } from '~/components/Apps/ModQuerySurface';
import { moderatorAppUrl } from '~/components/Moderation/ModeratorLookupMenuItem';
import {
  APP_FEEDBACK_HIDDEN_FILTER_OPTIONS,
  APP_FEEDBACK_HIDE_COPY,
  APP_FEEDBACK_OWNER_STATUS_FILTER_OPTIONS,
  appFeedbackHideErrorView,
  appFeedbackModFiltersToQuery,
  parseAppFeedbackModFilters,
  patchHiddenInPages,
  toAppFeedbackModRowView,
  toModListInput,
  type AppFeedbackHiddenFilter,
  type AppFeedbackModFilters,
  type AppFeedbackModRowView,
} from '~/components/Apps/appFeedbackModView';
import type { AppFeedbackOwnerStatusFilter } from '~/server/schema/app-feedback.schema';
import { formatDate } from '~/utils/date-helpers';
import { showErrorNotification, showSuccessNotification } from '~/utils/notifications';
import { trpc } from '~/utils/trpc';
import type { RouterOutput } from '~/types/router';

type ModRow = RouterOutput['appFeedback']['modList']['items'][number];

const DATE_FORMAT = 'MMM D, YYYY HH:mm';
const LISTING_SEARCH_LIMIT = 25;

function AppPicker({
  value,
  disabled,
  onChange,
}: {
  value: string | null;
  disabled: boolean;
  onChange: (value: string | null) => void;
}) {
  const [search, setSearch] = useState('');
  const [debouncedSearch] = useDebouncedValue(search.trim(), 300);
  const listings = trpc.appListings.listAllListingsForModeration.useQuery(
    { search: debouncedSearch || undefined, limit: LISTING_SEARCH_LIMIT },
    { retry: false, enabled: !disabled }
  );
  const data = useMemo(() => {
    const options = (listings.data?.items ?? []).map((l) => ({ value: l.id, label: l.name }));
    // A deep-linked listing may not be in the current search page; keep it selectable.
    if (value && !options.some((o) => o.value === value)) options.unshift({ value, label: value });
    return options;
  }, [listings.data, value]);

  return (
    <Select
      label="App"
      placeholder="All apps"
      searchable
      clearable
      disabled={disabled}
      data={data}
      value={value}
      onChange={onChange}
      searchValue={search}
      onSearchChange={setSearch}
      nothingFoundMessage={listings.isFetching ? 'Searching…' : 'No apps found'}
      w={240}
      data-testid="app-feedback-filter-app"
    />
  );
}

function RowMeta({ label, children }: { label: string; children: ReactNode }) {
  return (
    <Group gap={4} wrap="nowrap">
      <Text size="xs" c="dimmed">
        {label}:
      </Text>
      <Text size="xs" component="div">
        {children}
      </Text>
    </Group>
  );
}

function FeedbackRow({
  row,
  view,
  busy,
  onAction,
}: {
  row: ModRow;
  view: AppFeedbackModRowView;
  busy: boolean;
  onAction: () => void;
}) {
  return (
    <Paper
      withBorder
      p="sm"
      data-testid="app-feedback-row"
      data-feedback-id={row.id}
      data-hidden={view.hidden ? 'true' : 'false'}
    >
      <Stack gap={6}>
        <Group justify="space-between" align="flex-start" wrap="nowrap">
          <Group gap="xs">
            {view.appHref ? (
              <Anchor component={Link} href={view.appHref} fw={600} size="sm">
                {view.appLabel}
              </Anchor>
            ) : (
              <Text fw={600} size="sm" c={view.listingDeleted ? 'dimmed' : undefined}>
                {view.appLabel}
              </Text>
            )}
            {view.listingDeleted && (
              <Badge size="xs" color="gray" variant="light">
                Listing deleted
              </Badge>
            )}
            {view.flagged && (
              <Badge size="xs" color="red" variant="light">
                Flagged by developer
              </Badge>
            )}
            {view.hidden && (
              <Badge size="xs" color="orange" variant="light" data-testid="app-feedback-hidden">
                Hidden from developer{view.hiddenBy ? ` by ${view.hiddenBy}` : ''}
              </Badge>
            )}
          </Group>
          <Group gap="xs" wrap="nowrap">
            <Text size="xs" c="dimmed">
              {formatDate(row.createdAt, DATE_FORMAT)}
            </Text>
            <Button
              size="xs"
              variant="default"
              color={view.action === 'hide' ? 'red' : undefined}
              loading={busy}
              onClick={onAction}
            >
              {APP_FEEDBACK_HIDE_COPY[view.action].button}
            </Button>
          </Group>
        </Group>

        <Text size="sm" style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>
          {row.message}
        </Text>

        <Group gap="md" wrap="wrap">
          <RowMeta label="Reporter">
            <Group gap={4} wrap="nowrap">
              {view.reporterHref ? (
                <Anchor component={Link} href={view.reporterHref} size="xs">
                  {view.reporterLabel}
                </Anchor>
              ) : (
                view.reporterLabel
              )}
              {view.reporterBanned && (
                <Badge size="xs" color="red" data-testid="app-feedback-reporter-banned">
                  Banned
                </Badge>
              )}
              {view.reporterMuted && (
                <Badge size="xs" color="yellow">
                  Muted
                </Badge>
              )}
            </Group>
          </RowMeta>
          {view.ownerLabel && <RowMeta label="Owner">{view.ownerLabel}</RowMeta>}
          {view.versionLabel && <RowMeta label="Version">{view.versionLabel}</RowMeta>}
          {view.surfaceLabel && <RowMeta label="Surface">{view.surfaceLabel}</RowMeta>}
          {view.modelHref && (
            <RowMeta label="Model">
              <Anchor component={Link} href={view.modelHref} size="xs">
                {view.modelLabel}
              </Anchor>
            </RowMeta>
          )}
          <RowMeta label="Developer status">
            {view.ownerStatusLabel}
            {view.ownerStatusBy ? ` by ${view.ownerStatusBy}` : ''}
            {view.ownerStatusAt ? ` · ${formatDate(view.ownerStatusAt, DATE_FORMAT)}` : ''}
          </RowMeta>
          <RowMeta label="Triage">
            <Group gap={4} wrap="nowrap">
              {view.triageStatus}
              <Anchor href={view.triageHref} target="_blank" rel="noopener noreferrer" size="xs">
                Triage in moderator app
              </Anchor>
            </Group>
          </RowMeta>
        </Group>
        {view.triageNote && (
          <Text size="xs" c="dimmed" style={{ whiteSpace: 'pre-wrap' }}>
            Triage note: {view.triageNote}
          </Text>
        )}
      </Stack>
    </Paper>
  );
}

export function AppFeedbackModQueue() {
  const router = useRouter();
  const filters = useMemo(() => parseAppFeedbackModFilters(router.query), [router.query]);
  const setFilters = (patch: Partial<AppFeedbackModFilters>) => {
    const next = { ...filters, ...patch };
    const query = { ...router.query };
    for (const [key, value] of Object.entries(appFeedbackModFiltersToQuery(next))) {
      if (value === undefined) delete query[key];
      else query[key] = value;
    }
    void router.replace({ pathname: router.pathname, query }, undefined, { shallow: true });
  };

  const utils = trpc.useUtils();
  const listInput = toModListInput(filters);
  const list = trpc.appFeedback.modList.useInfiniteQuery(listInput, {
    getNextPageParam: (lastPage) => lastPage.nextCursor,
    retry: false,
  });
  const [pending, setPending] = useState<{ row: ModRow; action: 'hide' | 'unhide' } | null>(null);

  const refresh = () =>
    Promise.all([
      utils.appFeedback.modList.invalidate(),
      utils.appFeedback.modCountFlagged.invalidate(),
    ]);

  const setHidden = trpc.appFeedback.modSetHidden.useMutation({
    onSuccess: async (data) => {
      showSuccessNotification({
        message: APP_FEEDBACK_HIDE_COPY[data.hidden ? 'hide' : 'unhide'].done,
      });
      setPending(null);
      // Every other cached filter view goes stale and refetches on its next visit, by which time
      // the replica has usually caught up. The one on screen is patched, which also clears its
      // stale mark; an in-flight fetch of it is cancelled first so its result cannot overwrite it.
      await utils.appFeedback.modList.invalidate(undefined, { refetchType: 'none' });
      await utils.appFeedback.modList.cancel(listInput);
      utils.appFeedback.modList.setInfiniteData(listInput, (prev) =>
        patchHiddenInPages(prev, {
          id: data.id,
          hidden: data.hidden,
          filter: listInput.hidden,
          now: new Date(),
        })
      );
      await utils.appFeedback.modCountFlagged.invalidate();
    },
    onError: (error) => {
      const view = appFeedbackHideErrorView(error);
      showErrorNotification({
        title: 'Could not update the report',
        error: new Error(view.message),
      });
      setPending(null);
      if (view.refetch) void refresh();
    },
  });

  const rows = useMemo(() => list.data?.pages.flatMap((p) => p.items) ?? [], [list.data]);

  if (list.error && isModAuthzError(list.error)) return null;

  return (
    <Stack gap="md" data-testid="app-feedback-mod-queue">
      <Group align="flex-end" gap="md" wrap="wrap">
        <AppPicker
          value={filters.appListingId}
          disabled={filters.listingDeleted}
          onChange={(appListingId) => setFilters({ appListingId })}
        />
        <Checkbox
          label="Listing deleted"
          checked={filters.listingDeleted}
          onChange={(e) =>
            setFilters({ listingDeleted: e.currentTarget.checked, appListingId: null })
          }
        />
        <Select
          label="Developer status"
          placeholder="Any"
          clearable
          data={APP_FEEDBACK_OWNER_STATUS_FILTER_OPTIONS}
          value={filters.ownerStatus}
          onChange={(v) => setFilters({ ownerStatus: (v as AppFeedbackOwnerStatusFilter) ?? null })}
          w={180}
          data-testid="app-feedback-filter-owner-status"
        />
        <Checkbox
          label="Flagged by developer"
          checked={filters.flagged}
          onChange={(e) => setFilters({ flagged: e.currentTarget.checked })}
        />
        <Select
          label="Hidden from developer"
          data={APP_FEEDBACK_HIDDEN_FILTER_OPTIONS}
          value={filters.hidden}
          allowDeselect={false}
          onChange={(v) => setFilters({ hidden: (v as AppFeedbackHiddenFilter) ?? 'all' })}
          w={200}
          data-testid="app-feedback-filter-hidden"
        />
      </Group>

      {list.isLoading ? (
        <Center py="xl">
          <Loader />
        </Center>
      ) : list.error ? (
        <ModQueryError
          error={list.error}
          onRetry={() => list.refetch()}
          isRetrying={list.isFetching}
          title="Couldn’t load app feedback"
        />
      ) : !rows.length ? (
        <Text c="dimmed" py="lg" ta="center">
          No app feedback matches these filters.
        </Text>
      ) : (
        <Stack gap="sm">
          {rows.map((row) => {
            const view = toAppFeedbackModRowView(row, moderatorAppUrl);
            return (
              <FeedbackRow
                key={row.id}
                row={row}
                view={view}
                busy={setHidden.isPending && setHidden.variables?.id === row.id}
                onAction={() => setPending({ row, action: view.action })}
              />
            );
          })}
          {list.hasNextPage && (
            <Center>
              <Button
                variant="default"
                onClick={() => list.fetchNextPage()}
                loading={list.isFetchingNextPage}
              >
                Load more
              </Button>
            </Center>
          )}
        </Stack>
      )}

      <Modal
        opened={pending != null}
        onClose={() => setPending(null)}
        title={pending ? APP_FEEDBACK_HIDE_COPY[pending.action].title : ''}
      >
        <Stack gap="sm">
          <Text size="sm">{pending ? APP_FEEDBACK_HIDE_COPY[pending.action].body : ''}</Text>
          <Group justify="flex-end">
            <Button variant="default" onClick={() => setPending(null)}>
              Cancel
            </Button>
            <Button
              color={pending?.action === 'hide' ? 'red' : undefined}
              loading={setHidden.isPending}
              onClick={() =>
                pending &&
                setHidden.mutate({ id: pending.row.id, hidden: pending.action === 'hide' })
              }
              data-testid="app-feedback-confirm"
            >
              {pending ? APP_FEEDBACK_HIDE_COPY[pending.action].button : ''}
            </Button>
          </Group>
        </Stack>
      </Modal>
    </Stack>
  );
}
