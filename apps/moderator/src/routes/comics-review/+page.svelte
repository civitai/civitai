<script lang="ts">
  import { enhance } from '$app/forms';
  import { goto } from '$app/navigation';
  import { page } from '$app/state';
  import { SvelteMap } from 'svelte/reactivity';
  import type { SubmitFunction } from '@sveltejs/kit';
  import { Badge } from '@civitai/ui/components/ui/badge/index.js';
  import { Button } from '@civitai/ui/components/ui/button/index.js';
  import { Card, CardContent } from '@civitai/ui/components/ui/card/index.js';
  import EdgeMedia from '$lib/components/EdgeMedia.svelte';
  import PromptHighlight from '$lib/components/PromptHighlight.svelte';
  import type { PageData } from './$types';

  let { data }: { data: PageData } = $props();
  type Panel = PageData['items'][number];

  // panelId → verdict; optimistic (dims the card + shows the outcome), cleared on a fresh page/filter.
  const acted = new SvelteMap<number, 'Approved' | 'Blocked'>();
  $effect(() => {
    data.items;
    acted.clear();
  });

  function urlWith(params: Record<string, string | number | null>) {
    const url = new URL(page.url);
    for (const [k, v] of Object.entries(params)) {
      if (v === null) url.searchParams.delete(k);
      else url.searchParams.set(k, String(v));
    }
    return url.pathname + url.search;
  }

  const submit =
    (panelId: number, verdict: 'Approved' | 'Blocked'): SubmitFunction =>
    () => {
      acted.set(panelId, verdict);
      return async ({ update }) => update({ invalidateAll: false });
    };

  const INGESTION_LABEL: Record<string, string> = {
    Pending: 'Awaiting scan',
    Blocked: 'Blocked by scanner',
    Error: 'Scan error',
    NotFound: 'Not found',
    PendingManualAssignment: 'Pending manual review',
    Rescan: 'Queued for rescan',
  };

  type Signal = { label: string; class: string };
  function signals(p: Panel): Signal[] {
    const out: Signal[] = [];
    if (p.tosViolation) out.push({ label: 'TOS violation', class: 'bg-red-600 text-white' });
    if (p.blockedFor) out.push({ label: p.blockedFor, class: 'bg-orange-500/20 text-orange-400' });
    if (p.needsReview)
      out.push({ label: `Review: ${p.needsReview}`, class: 'bg-orange-500/15 text-orange-300' });
    if (p.ingestion !== 'Scanned' && !p.blockedFor)
      out.push({
        label: INGESTION_LABEL[p.ingestion] ?? p.ingestion,
        class: 'bg-muted text-muted-foreground',
      });
    if (p.projectTosViolation) out.push({ label: 'Project TOS', class: 'bg-red-500/15 text-red-400' });
    if (p.authorBannedAt) out.push({ label: 'Author banned', class: 'bg-red-500/15 text-red-400' });
    if (p.projectStatus !== 'Active')
      out.push({ label: p.projectStatus, class: 'bg-muted text-muted-foreground' });
    return out;
  }
</script>

<header class="page-header">
  <h1>Comics Review</h1>
  <p class="text-sm text-muted-foreground">
    Comic panels whose image was flagged for review or marked a TOS violation. Approving lifts the comic
    back into the public listing.
  </p>
  <div class="mt-2 flex flex-wrap items-center gap-2">
    <select
      class="h-8 rounded-md border bg-background px-2 text-sm"
      value={data.needsReview}
      onchange={(e) => goto(urlWith({ needsReview: e.currentTarget.value, cursor: null }))}
    >
      {#each data.reasons as r (r.value)}<option value={r.value}>{r.label}</option>{/each}
    </select>
    <select
      class="h-8 rounded-md border bg-background px-2 text-sm"
      value={data.limit}
      onchange={(e) => goto(urlWith({ limit: e.currentTarget.value, cursor: null }))}
    >
      {#each [10, 25, 50] as n (n)}<option value={n}>{n} per page</option>{/each}
    </select>
  </div>
</header>

{#if data.items.length === 0}
  <div class="placeholder">No comic panels awaiting review.</div>
{:else}
  <div class="grid gap-4" style="grid-template-columns: repeat(auto-fill, minmax(280px, 1fr))">
    {#each data.items as p (p.id)}
      {@const verdict = acted.get(p.id)}
      <Card class="gap-0 overflow-hidden p-0 transition-opacity {verdict ? 'opacity-60' : ''}">
        <a
          href={`${data.civitaiUrl}/images/${p.imageId}`}
          target="_blank"
          rel="noreferrer"
          class="block aspect-[3/4] overflow-hidden bg-muted"
        >
          <EdgeMedia src={p.imageUrl} type={p.imageType} width={450} class="size-full object-cover" />
        </a>
        <CardContent class="flex flex-col gap-2 p-2.5 text-sm">
          <div class="flex flex-wrap gap-1">
            {#each signals(p) as s (s.label)}
              <Badge class="border-transparent {s.class}">{s.label}</Badge>
            {/each}
          </div>

          <a
            href={`${data.civitaiUrl}/comics/project/${p.projectId}`}
            target="_blank"
            rel="noreferrer"
            class="truncate font-semibold hover:underline">{p.projectName}</a
          >
          <div class="text-xs text-muted-foreground">
            by
            {#if p.authorDeletedAt}(deleted user #{p.authorId}){:else}{p.authorUsername ??
                `user #${p.authorId}`}{/if}
            · ch. <span class="font-medium">{p.chapterName}</span> · panel #{p.position + 1}
          </div>
          {#if p.promptHighlight}
            <PromptHighlight result={p.promptHighlight} />
          {:else if p.uploaded}
            <p class="text-xs italic text-muted-foreground">Off-site upload — no prompt.</p>
          {/if}

          {#if verdict}
            <span
              class="text-xs font-semibold {verdict === 'Approved'
                ? 'text-teal-500'
                : 'text-rose-500'}">✓ {verdict}</span
            >
          {:else}
            <div class="flex flex-wrap gap-1.5">
              <form method="POST" action="?/approve" use:enhance={submit(p.id, 'Approved')}>
                <input type="hidden" name="imageId" value={p.imageId} />
                <input type="hidden" name="projectId" value={p.projectId} />
                <button
                  type="submit"
                  class="rounded border border-teal-600/40 px-2 py-1 text-xs font-semibold text-teal-400 transition hover:bg-teal-500/10"
                  >Approve</button
                >
              </form>
              <form method="POST" action="?/block" use:enhance={submit(p.id, 'Blocked')}>
                <input type="hidden" name="imageId" value={p.imageId} />
                <input type="hidden" name="projectId" value={p.projectId} />
                <button
                  type="submit"
                  class="rounded border border-rose-500/40 px-2 py-1 text-xs font-semibold text-rose-400 transition hover:bg-rose-500/10"
                  >Block</button
                >
              </form>
            </div>
          {/if}
        </CardContent>
      </Card>
    {/each}
  </div>

  <div class="mt-6 flex justify-center">
    {#if data.nextCursor}
      <Button size="lg" onclick={() => goto(urlWith({ cursor: data.nextCursor ?? null }))}>Next</Button>
    {:else}
      <span class="text-sm text-muted-foreground">End of queue.</span>
    {/if}
  </div>
{/if}
