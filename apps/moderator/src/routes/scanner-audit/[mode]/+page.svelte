<script lang="ts">
  import { goto } from '$app/navigation';
  import { page } from '$app/state';
  import { IconDownload } from '@tabler/icons-svelte';
  import { Tabs, TabsList, TabsTrigger } from '@civitai/ui/components/ui/tabs/index.js';
  import { Input } from '@civitai/ui/components/ui/input/index.js';
  import { Button } from '@civitai/ui/components/ui/button/index.js';
  import { Badge } from '@civitai/ui/components/ui/badge/index.js';
  import {
    Table,
    TableBody,
    TableCell,
    TableHead,
    TableHeader,
    TableRow,
  } from '@civitai/ui/components/ui/table/index.js';
  import {
    Pagination,
    PaginationContent,
    PaginationEllipsis,
    PaginationItem,
    PaginationLink,
    PaginationNext,
    PaginationPrevious,
  } from '@civitai/ui/components/ui/pagination/index.js';
  import { SCANNER_MODES, verdictShort, verdictClass, VERDICT_ORDER } from '$lib/scanner-audit';
  import type { PageData } from './$types';

  let { data }: { data: PageData } = $props();

  const totalPages = $derived(Math.max(1, Math.ceil(data.total / data.limit)));
  const fmtDate = (d: string) => new Date(d).toLocaleString();

  function urlWith(params: Record<string, string | number | null>) {
    const url = new URL(page.url);
    for (const [k, v] of Object.entries(params)) {
      if (v === null || v === '') url.searchParams.delete(k);
      else url.searchParams.set(k, String(v));
    }
    return url.pathname + url.search;
  }

  function applyFilters(e: SubmitEvent) {
    e.preventDefault();
    const form = new FormData(e.currentTarget as HTMLFormElement);
    goto(
      urlWith({
        label: String(form.get('label') ?? '').trim() || null,
        version: String(form.get('version') ?? '').trim() || null,
        page: 1,
      })
    );
  }

  // Focused per-label review — in the spoke, same app.
  const labelHref = (label: string) =>
    `/scanner-audit/${data.mode}/${encodeURIComponent(label)}`;

  const exportHref = $derived(
    (() => {
      const p = new URLSearchParams({ view: data.view });
      if (data.label) p.set('label', data.label);
      if (data.version) p.set('version', data.version);
      return `/scanner-audit/${data.mode}/export?${p}`;
    })()
  );

  const coverageTotal = $derived(data.stats.active.reduce((sum, r) => sum + r.total, 0));
</script>

<header class="page-header flex flex-wrap items-center justify-between gap-2">
  <h1>Scanner Audit</h1>
  <Button href={exportHref} variant="outline" size="sm">
    <IconDownload size={14} /> Export CSV
  </Button>
</header>

<Tabs value={data.mode} onValueChange={(v) => v && goto(`/scanner-audit/${v}`)} class="mb-4">
  <TabsList>
    {#each SCANNER_MODES as m (m.value)}
      <TabsTrigger value={m.value}>{m.label}</TabsTrigger>
    {/each}
  </TabsList>
</Tabs>

<form class="mb-4 flex flex-wrap items-end gap-2" onsubmit={applyFilters}>
  <div class="flex flex-col gap-1">
    <span class="text-xs font-medium text-muted-foreground">Label</span>
    <Input name="label" value={data.label} placeholder="e.g. csam" class="h-8 w-48" />
  </div>
  <div class="flex flex-col gap-1">
    <span class="text-xs font-medium text-muted-foreground">Policy version</span>
    <Input name="version" value={data.version} placeholder="version" class="h-8 w-56" />
  </div>
  <Button type="submit" size="sm" variant="outline">Search</Button>
</form>

<!-- Review coverage -->
<div class="mb-4 rounded-xl border p-3">
  <div class="mb-2 flex items-center justify-between">
    <span class="text-sm font-medium">Moderator review coverage</span>
    <span class="text-xs text-muted-foreground">
      {coverageTotal.toLocaleString()} reviews across {data.stats.active.length} labels
    </span>
  </div>
  {#if data.stats.active.length === 0}
    <p class="text-sm text-muted-foreground">No moderator reviews recorded yet for this scanner.</p>
  {:else}
    <div class="max-h-64 overflow-auto">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Label</TableHead>
            <TableHead>Reviews</TableHead>
            <TableHead>Mods</TableHead>
            <TableHead>Verdicts</TableHead>
            <TableHead>Last reviewed</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {#each data.stats.active as s (s.label)}
            <TableRow>
              <TableCell>
                <a href={labelHref(s.label)} class="font-mono underline">{s.label}</a>
              </TableCell>
              <TableCell>{s.total.toLocaleString()}</TableCell>
              <TableCell>{s.reviewers.toLocaleString()}</TableCell>
              <TableCell>
                <div class="flex flex-wrap gap-1">
                  {#each VERDICT_ORDER as v (v)}
                    {@const count = s[
                      v === 'TruePositive'
                        ? 'truePositive'
                        : v === 'FalsePositive'
                          ? 'falsePositive'
                          : v === 'TrueNegative'
                            ? 'trueNegative'
                            : v === 'FalseNegative'
                              ? 'falseNegative'
                              : 'unsure'
                    ]}
                    <Badge class={count === 0 ? 'bg-muted text-muted-foreground opacity-40' : verdictClass[v]}>
                      {verdictShort[v]} {count.toLocaleString()}
                    </Badge>
                  {/each}
                </div>
              </TableCell>
              <TableCell class="text-xs text-muted-foreground">
                {s.lastReviewedAt ? fmtDate(s.lastReviewedAt) : '—'}
              </TableCell>
            </TableRow>
          {/each}
        </TableBody>
      </Table>
    </div>
  {/if}
  {#if data.stats.retired.length > 0}
    <p class="mt-2 text-xs text-muted-foreground">
      Hidden — retired labels no longer produced by this scanner:
      {data.stats.retired.map((r) => `${r.label} (${r.total.toLocaleString()})`).join(', ')}
    </p>
  {/if}
</div>

<Tabs value={data.view} onValueChange={(v) => v && goto(urlWith({ view: v, page: 1 }))} class="mb-4">
  <TabsList>
    <TabsTrigger value="triggered">Triggered (FP review)</TabsTrigger>
    <TabsTrigger value="near-miss">Near-miss (FN review)</TabsTrigger>
  </TabsList>
</Tabs>

{#if data.rows.length === 0}
  <div class="placeholder">No {data.view} decisions match the current filters in the last 30 days.</div>
{:else}
  <div class="rounded-xl border">
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>Label</TableHead>
          <TableHead>Score</TableHead>
          <TableHead>Threshold</TableHead>
          <TableHead>Occurrences</TableHead>
          <TableHead>Policy</TableHead>
          <TableHead>Status</TableHead>
          <TableHead>Last seen</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {#each data.rows as r (`${r.contentHash}::${r.version}::${r.label}`)}
          <TableRow>
            <TableCell>
              <a href={labelHref(r.label)} class="font-mono underline">{r.label}</a>
              {#if r.labelValue}<span class="ml-1 text-xs text-muted-foreground">= {r.labelValue}</span>{/if}
            </TableCell>
            <TableCell class="tabular-nums">{r.score.toFixed(3)}</TableCell>
            <TableCell class="tabular-nums">{r.threshold !== null ? r.threshold.toFixed(2) : '—'}</TableCell>
            <TableCell class="tabular-nums">{r.occurrences.toLocaleString()}</TableCell>
            <TableCell class="font-mono text-xs text-muted-foreground" title={r.version || '(none)'}>
              {r.version ? `${r.version.slice(0, 10)}…` : '—'}
            </TableCell>
            <TableCell>
              {#if r.myVerdict}
                <Badge class={verdictClass[r.myVerdict]}>{verdictShort[r.myVerdict]}</Badge>
              {:else if r.anyVerdict}
                <Badge class={verdictClass[r.anyVerdict]} title="Verdict from another moderator">
                  {verdictShort[r.anyVerdict]}
                </Badge>
              {/if}
            </TableCell>
            <TableCell class="whitespace-nowrap text-xs text-muted-foreground">
              {fmtDate(r.lastSeenAt)}
            </TableCell>
          </TableRow>
        {/each}
      </TableBody>
    </Table>
  </div>
{/if}

<div class="mt-4 flex flex-wrap items-center justify-between gap-2">
  <span class="text-sm text-muted-foreground">
    {data.total.toLocaleString()} matching decisions · page {data.page} of {totalPages}
  </span>
  <Pagination
    count={data.total}
    perPage={data.limit}
    page={data.page}
    onPageChange={(p) => p !== data.page && goto(urlWith({ page: p }))}
  >
    {#snippet children({ pages, currentPage })}
      <PaginationContent>
        <PaginationItem><PaginationPrevious /></PaginationItem>
        {#each pages as p (p.key)}
          {#if p.type === 'ellipsis'}
            <PaginationItem><PaginationEllipsis /></PaginationItem>
          {:else}
            <PaginationItem>
              <PaginationLink page={p} isActive={currentPage === p.value}>{p.value}</PaginationLink>
            </PaginationItem>
          {/if}
        {/each}
        <PaginationItem><PaginationNext /></PaginationItem>
      </PaginationContent>
    {/snippet}
  </Pagination>
</div>
