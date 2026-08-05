<script lang="ts">
  import * as Table from '@civitai/ui/components/ui/table/index.js';
  import * as ToggleGroup from '@civitai/ui/components/ui/toggle-group/index.js';
  import DeltaChip from '$lib/components/DeltaChip.svelte';
  import CurrencyDisplay from '$lib/components/CurrencyDisplay.svelte';
  import {
    IconArrowUp,
    IconArrowDown,
    IconArrowsSort,
    IconChevronRight,
  } from '@tabler/icons-svelte';
  import { page } from '$app/state';
  import { tableSortState } from '$lib/state/table-sort.svelte';
  import { formatRange } from '$lib/date-range';
  import { currencyMeta, currencySort, hasDisplayValue } from '$lib/earnings';
  import {
    BANKABLE_CURRENCIES,
    FILTERABLE_CURRENCIES,
    currencySelectionKind,
  } from '$lib/buzz-currency-filter';
  import { buzzCurrencyState } from '$lib/state/buzz-currency.svelte';
  import { modelGroupingState } from '$lib/state/model-grouping.svelte';
  import { analyticsPageSize } from '$lib/stores/analytics-page-size';
  import Pagination from '$lib/components/Pagination.svelte';
  import AnalyticsHeader from '$lib/components/AnalyticsHeader.svelte';
  import type { PageData } from './$types';

  let { data }: { data: PageData } = $props();
  const num = (n: number) => n.toLocaleString();
  const periodLabel = $derived(`for ${formatRange(data.range)}`);
  const perPage = $derived(analyticsPageSize.value);

  type Row = NonNullable<PageData['modelPerformance']>[number];

  // One column per earning channel. Currency no longer gets its own columns — it moved into the
  // expandable breakdown, so the header stays flat however many account types a creator has.
  const CHANNELS = [
    'licenseFee',
    'compensation',
    'earlyAccess',
    'permanentAccess',
    'donation',
  ] as const;
  // Short headers: eight columns at full width push the last one past the container's right edge and
  // behind the horizontal scroll, where it reads as missing. Full names live in the header tooltip and
  // in the expanded breakdown, which has room for them.
  const CHANNEL_HEAD: Record<(typeof CHANNELS)[number], string> = {
    licenseFee: 'License Fees',
    compensation: 'Compensation',
    earlyAccess: 'Early Access',
    permanentAccess: 'Perm. Access',
    donation: 'Donations',
  };
  const CHANNEL_FULL: Record<(typeof CHANNELS)[number], string> = {
    licenseFee: 'License fees earned from generations using this model',
    compensation: 'Generation compensation',
    earlyAccess: 'Early access sales (timed window), as sold',
    permanentAccess: 'Permanent paid-access sales, as sold',
    donation: 'Donations to goals attached to this model',
  };
  // Namespaced so a channel key can never collide with `generations` / `downloads` in sortValue.
  const CHANNEL_SORT_PREFIX = 'channel:';
  const CASH_SORT_PREFIX = 'cash:';

  const grouping = modelGroupingState(() => data.grouping);

  // Rolled up in the browser rather than by a second query: the payload already carries every version, and
  // the currency filter has to apply to the same numbers either way. Versions whose model was deleted have
  // no modelId to group by, so they stay individual rows.
  const rows = $derived.by((): Row[] => {
    const versions = data.modelPerformance ?? [];
    if (grouping.value === 'version') return versions;

    const byModel = new Map<number, Row>();
    const out: Row[] = [];
    for (const v of versions) {
      if (v.modelId == null) {
        out.push(v);
        continue;
      }
      const existing = byModel.get(v.modelId);
      if (!existing) {
        // Deep-copied: the accumulators below mutate, and `data` is the load's payload.
        const seed: Row = {
          ...v,
          versionName: null,
          currencies: v.currencies.map((c) => ({ ...c })),
          channels: Object.fromEntries(
            CHANNELS.map((c) => [
              c,
              { ...v.channels[c], received: v.channels[c].received.map((r) => ({ ...r })) },
            ])
          ) as Row['channels'],
        };
        byModel.set(v.modelId, seed);
        out.push(seed);
        continue;
      }
      existing.generations += v.generations;
      existing.prevGenerations += v.prevGenerations;
      existing.downloads += v.downloads;
      existing.prevDownloads += v.prevDownloads;
      existing.buzzTotal += v.buzzTotal;
      existing.prevBuzzTotal += v.prevBuzzTotal;
      for (const c of v.currencies) {
        const hit = existing.currencies.find((x) => x.currency === c.currency);
        if (hit) {
          hit.total += c.total;
          hit.prev = (hit.prev ?? 0) + (c.prev ?? 0);
        } else existing.currencies.push({ ...c });
      }
      for (const ch of CHANNELS) {
        const target = existing.channels[ch];
        const src = v.channels[ch];
        target.total += src.total;
        target.prev += src.prev;
        for (const r of src.received) {
          const hit = target.received.find((x) => x.currency === r.currency);
          if (hit) {
            hit.total += r.total;
            hit.prev += r.prev;
          } else target.received.push({ ...r });
        }
      }
    }
    return out;
  });

  // How many versions each model row folds up, so a rolled-up row says so rather than looking like one.
  const versionCounts = $derived.by(() => {
    const counts = new Map<number, number>();
    for (const v of data.modelPerformance ?? [])
      if (v.modelId != null) counts.set(v.modelId, (counts.get(v.modelId) ?? 0) + 1);
    return counts;
  });

  // Earnings-column currency filter. The payload carries per-currency totals for every channel, so this
  // is a local recompute; the cookie only persists the choice and lets SSR render filtered numbers.
  const currencies = buzzCurrencyState(() => data.buzzCurrencies);
  const selected = $derived(currencies.value);
  const selectedSet = $derived(new Set<string>(selected));
  const selectionKind = $derived(currencySelectionKind(selected));
  const selectionLabel = $derived(
    selectionKind === 'bankable'
      ? 'Withdrawable buzz'
      : selectionKind === 'all'
        ? 'All buzz'
        : selected.map((c: string) => currencyMeta(c).label).join(' + ')
  );

  const channelTotal = (m: Row, c: (typeof CHANNELS)[number]) =>
    m.channels[c].received.reduce(
      (sum, r) => (selectedSet.has(r.currency) ? sum + r.total : sum),
      0
    );
  const channelPrev = (m: Row, c: (typeof CHANNELS)[number]) =>
    m.channels[c].received.reduce(
      (sum, r) => (selectedSet.has(r.currency) ? sum + r.prev : sum),
      0
    );

  // Cash settles separately and is never summed with buzz, so it gets its own column and ignores the
  // chips entirely. Without it, a fee that settles to cash is absent from the page rather than zero.
  const cashCurrencies = $derived(
    data.modelPerformance
      ? [
          ...new Set(
            data.modelPerformance.flatMap((m) =>
              m.currencies
                .filter((c) => currencyMeta(c.currency).family === 'cash')
                .map((c) => c.currency)
            )
          ),
        ].sort(currencySort)
      : []
  );
  const cashCell = (m: Row, currency: string) =>
    m.currencies.find((c) => c.currency === currency)?.total ?? 0;
  const cashPrev = (m: Row, currency: string) =>
    m.currencies.find((c) => c.currency === currency)?.prev ?? 0;

  // Sort + page live in the URL (shallow routing) — sort replaces history, page pushes. Default: generations desc.
  const sorting = tableSortState('models', () => data.tableSort, {
    sort: 'generations',
    dir: 'desc',
  });
  const sortKey = $derived(sorting.key);
  const sortDir = $derived(sorting.dir);
  const pageNum = $derived(Math.max(1, Number(page.url.searchParams.get('page')) || 1));

  const sortValue = (m: Row, key: string): number =>
    key === 'generations'
      ? m.generations
      : key === 'downloads'
        ? m.downloads
        : key.startsWith(CHANNEL_SORT_PREFIX)
          ? channelTotal(m, key.slice(CHANNEL_SORT_PREFIX.length) as (typeof CHANNELS)[number])
          : key.startsWith(CASH_SORT_PREFIX)
            ? cashCell(m, key.slice(CASH_SORT_PREFIX.length))
            : m.generations;
  const sorted = $derived.by(() => {
    const list = [...rows];
    const dir = sortDir === 'desc' ? -1 : 1;
    return list.sort((a, b) => dir * (sortValue(a, sortKey) - sortValue(b, sortKey)));
  });
  const totalPages = $derived(Math.max(1, Math.ceil(sorted.length / perPage)));
  const curPage = $derived(Math.min(pageNum, totalPages));
  const pageRows = $derived(sorted.slice((curPage - 1) * perPage, curPage * perPage));
</script>

<AnalyticsHeader range={data.range} compare={data.compare} />

{#if data.modelPerformance && data.modelPerformance.length > 0}
  <div class="cs-panel p-4">
    <div class="mb-3 flex flex-wrap items-start justify-between gap-2">
      <p class="text-sm font-medium text-white">
        {grouping.value === 'model' ? 'Per-model' : 'Per-version'} performance
        <span class="text-xs text-dark-3">{periodLabel} · click a column to sort</span>
        <span class="ml-2 rounded bg-dark-5 px-1.5 py-0.5 text-xs font-normal text-dark-2">
          {selectionLabel}
        </span>
      </p>
      <div class="flex items-center gap-2">
        <span class="text-xs text-dark-3">View</span>
        <ToggleGroup.Root
          type="single"
          variant="outline"
          size="sm"
          spacing={1}
          value={grouping.value}
          onValueChange={(v: string) => v && grouping.set(v as 'version' | 'model')}
          aria-label="Group rows by version or by model"
        >
          <ToggleGroup.Item value="version" class="text-xs" title="One row per model version"
            >Versions</ToggleGroup.Item
          >
          <ToggleGroup.Item value="model" class="text-xs" title="Roll versions up into their model"
            >Models</ToggleGroup.Item
          >
        </ToggleGroup.Root>
        <span class="ml-2 text-xs text-dark-3">Counting</span>
        <ToggleGroup.Root
          type="multiple"
          variant="outline"
          size="sm"
          spacing={1}
          value={[...selected]}
          onValueChange={(v: string[]) => currencies.set(v)}
          aria-label="Which buzz types the earnings columns count"
        >
          {#each FILTERABLE_CURRENCIES as c (c)}
            <ToggleGroup.Item
              value={c}
              title={(BANKABLE_CURRENCIES as readonly string[]).includes(c)
                ? `${currencyMeta(c).label} — can be withdrawn`
                : `${currencyMeta(c).label} — cannot be withdrawn`}
              class="gap-1.5 text-xs"
            >
              <span class="size-2 shrink-0 rounded-full" style="background:{currencyMeta(c).color}"
              ></span>
              {currencyMeta(c).label}
            </ToggleGroup.Item>
          {/each}
        </ToggleGroup.Root>
      </div>
    </div>
    <!-- `title` is required, not optional: Svelte strips the TS annotation from a snippet parameter but
         not a `?`, so `title?: string` compiles to invalid JS and fails SSR parsing. -->
    {#snippet sortButton(key: string, label: string, title: string)}
      {@const active = sortKey === key}
      <button
        type="button"
        {title}
        onclick={() => sorting.toggle(key)}
        class="flex h-10 w-full cursor-pointer items-center justify-end gap-1 px-2 hover:text-white {active
          ? 'bg-dark-5/40 font-medium text-white'
          : 'text-dark-3'}"
      >
        <span>{label}</span>
        {#if active}
          {#if sortDir === 'asc'}
            <IconArrowUp size={14} class="text-blue-4" />
          {:else}
            <IconArrowDown size={14} class="text-blue-4" />
          {/if}
        {:else}
          <IconArrowsSort size={14} class="text-dark-4" />
        {/if}
      </button>
    {/snippet}
    <div class="mb-3">
      <Pagination
        total={sorted.length}
        noun={grouping.value === 'model' ? 'model' : 'version'}
        {curPage}
        {totalPages}
      />
    </div>
    <Table.Root>
      <Table.Header>
        <Table.Row>
          <Table.Head>{grouping.value === 'model' ? 'Model' : 'Model · version'}</Table.Head>
          <Table.Head class="p-0">
            {@render sortButton('generations', 'Generations', 'Generations using this model')}
          </Table.Head>
          <Table.Head class="p-0">
            {@render sortButton('downloads', 'Downloads', 'Downloads of this model')}
          </Table.Head>
          {#each CHANNELS as c (c)}
            <Table.Head class="p-0">
              {@render sortButton(CHANNEL_SORT_PREFIX + c, CHANNEL_HEAD[c], CHANNEL_FULL[c])}
            </Table.Head>
          {/each}
          {#each cashCurrencies as cc (cc)}
            <Table.Head class="border-l border-dark-4 p-0">
              {@render sortButton(
                CASH_SORT_PREFIX + cc,
                currencyMeta(cc).label,
                'Settled in cash, not buzz — unaffected by the buzz toggles'
              )}
            </Table.Head>
          {/each}
        </Table.Row>
      </Table.Header>
      <Table.Body>
        {#each pageRows as m (m.modelVersionId)}
          <Table.Row>
            <Table.Cell class="max-w-55 align-top">
              {#if m.modelId}
                <a
                  href="/analytics/models/{m.modelId}"
                  class="group flex items-center gap-1 font-medium text-blue-4 hover:text-blue-3"
                  title={m.modelName ?? ''}
                >
                  <span
                    class="min-w-0 truncate underline decoration-blue-4/40 underline-offset-2 group-hover:decoration-blue-3"
                  >
                    {m.modelName ?? 'Model ' + m.modelId}{#if m.versionName}<span
                        class="text-dark-3"
                      >
                        · {m.versionName}</span
                      >{/if}
                  </span>
                  <IconChevronRight size={14} class="shrink-0" />
                </a>
              {:else}
                <div class="truncate text-dark-2" title={m.versionName ?? ''}>
                  Version {m.modelVersionId}{#if m.versionName}<span class="text-dark-3">
                      · {m.versionName}</span
                    >{/if}
                </div>
              {/if}
              <div class="truncate text-xs text-dark-3">
                {m.modelType ?? '—'}{#if grouping.value === 'model' && m.modelId != null}
                  {@const n = versionCounts.get(m.modelId) ?? 1}
                  · {n} version{n === 1 ? '' : 's'}
                {/if}
              </div>
            </Table.Cell>
            <Table.Cell class="align-top text-right">
              <div class="tabular-nums {m.generations ? 'text-white' : 'text-dark-4'}">
                {m.generations ? num(m.generations) : '—'}
              </div>
              {#if m.generations}
                <div class="mt-0.5">
                  <DeltaChip current={m.generations} previous={m.prevGenerations} />
                </div>
              {/if}
            </Table.Cell>
            <Table.Cell class="align-top text-right">
              <div class="tabular-nums {m.downloads ? 'text-white' : 'text-dark-4'}">
                {m.downloads ? num(m.downloads) : '—'}
              </div>
              {#if m.downloads}
                <div class="mt-0.5">
                  <DeltaChip current={m.downloads} previous={m.prevDownloads} />
                </div>
              {/if}
            </Table.Cell>
            {#each CHANNELS as c (c)}
              {@const total = channelTotal(m, c)}
              {@const show = hasDisplayValue(total, 'yellow')}
              <Table.Cell class="align-top text-right">
                <div class="tabular-nums {show ? 'font-medium text-white' : 'text-dark-4'}">
                  {#if show}<CurrencyDisplay amount={total} />{:else}—{/if}
                </div>
                {#if show}
                  <div class="mt-0.5">
                    <DeltaChip current={total} previous={channelPrev(m, c)} />
                  </div>
                {/if}
              </Table.Cell>
            {/each}
            {#each cashCurrencies as cc (cc)}
              {@const amount = cashCell(m, cc)}
              {@const show = hasDisplayValue(amount, cc)}
              <Table.Cell class="border-l border-dark-4 align-top text-right">
                <div class="tabular-nums {show ? 'font-medium text-white' : 'text-dark-4'}">
                  {#if show}<CurrencyDisplay {amount} currency={cc} />{:else}—{/if}
                </div>
                {#if show}
                  <div class="mt-0.5">
                    <DeltaChip current={amount} previous={cashPrev(m, cc)} />
                  </div>
                {/if}
              </Table.Cell>
            {/each}
          </Table.Row>
        {/each}
      </Table.Body>
    </Table.Root>

    {#if totalPages > 1}
      <div class="mt-3">
        <Pagination
          total={sorted.length}
          noun={grouping.value === 'model' ? 'model' : 'version'}
          {curPage}
          {totalPages}
        />
      </div>
    {/if}
  </div>
{:else if data.modelPerformance === null}
  <div class="placeholder">
    Per-version performance is temporarily unavailable — please try again shortly.
  </div>
{:else}
  <div class="rounded-lg border border-dashed border-dark-4 p-4 text-sm text-dark-3">
    <strong class="text-dark-2">Per-version performance</strong> — no version activity {periodLabel} yet.
  </div>
{/if}
