<script lang="ts">
  import { browser } from '$app/environment';
  import { SvelteSet } from 'svelte/reactivity';
  import { Button } from '@civitai/ui/components/ui/button/index.js';
  import { fetchJson } from '$lib/fetch-json';
  import { LINK_CLASS, dateTime, num } from '$lib/format';
  import { denied } from '$lib/permissions';
  import { SSR_PENDING } from '$lib/ssr-pending';
  import {
    PROMPT_SCAN_DAYS,
    PROMPT_SCAN_LIMITS,
    type PromptScan,
  } from '$lib/prompt-scans';

  let { userId, canView }: { userId: number; canView: boolean } = $props();

  // Every load is a scan of the orchestrator's table and an audited read, so it waits for a click.
  let shown = $state(false);
  let days = $state<number>(PROMPT_SCAN_DAYS[1]);
  let limit = $state<number>(PROMPT_SCAN_LIMITS[0]);
  let sort = $state<'newest' | 'score'>('newest');
  let minScore = $state('');
  let revealAll = $state(false);
  const revealed = new SvelteSet<number>();

  const scans = $derived(
    shown && canView
      ? browser
        ? fetchJson<{ items: PromptScan[] }>(
            `/api/user-prompt-scans/${userId}?days=${days}&limit=${limit}`
          )
        : (SSR_PENDING as Promise<{ items: PromptScan[] }>)
      : null
  );

  const top = (s: PromptScan) => s.scores[0]?.score ?? 0;

  function visible(items: PromptScan[]) {
    const floor = Number(minScore);
    const kept =
      minScore.trim() && Number.isFinite(floor) ? items.filter((s) => top(s) >= floor) : items;
    return sort === 'score' ? [...kept].sort((a, b) => top(b) - top(a)) : kept;
  }
</script>

<section class="mb-4 rounded-xl border border-dark-4 bg-dark-6 p-5">
  <div class="flex flex-wrap items-center justify-between gap-2">
    <h3 class="text-sm font-semibold text-white">Generator prompts (XGuard)</h3>
    {#if canView}
      <Button size="xs" variant="outline" onclick={() => (shown = !shown)}>
        {shown ? 'Hide' : 'Show'}
      </Button>
    {/if}
  </div>

  {#if !canView}
    <p class="mt-3 text-sm text-dark-2">{denied('user.generations.view')}</p>
  {:else}
    <!-- Both gaps are blind spots, not footnotes: a moderator must not read an absent prompt as one the
         account never sent. -->
    <p class="mt-1 text-xs text-dark-2">
      The orchestrator's scan of each prompt this account sent to the generator, newest first. Not a
      complete history: a prompt keeps one row whoever sent it, so a prompt resent later by another
      account moves to them, and scans that failed or expired are not recorded. A prompt missing here
      is not evidence it was never submitted.
    </p>
  {/if}

  {#if scans}
    <div class="mt-3 flex flex-wrap items-center gap-3 text-xs text-dark-2">
      <label class="flex items-center gap-1">
        Window
        <select class="rounded bg-dark-5 px-1 py-0.5 text-dark-0" bind:value={days}>
          {#each PROMPT_SCAN_DAYS as d (d)}<option value={d}>{d} days</option>{/each}
        </select>
      </label>
      <label class="flex items-center gap-1">
        Up to
        <select class="rounded bg-dark-5 px-1 py-0.5 text-dark-0" bind:value={limit}>
          {#each PROMPT_SCAN_LIMITS as n (n)}<option value={n}>{n}</option>{/each}
        </select>
      </label>
      <label class="flex items-center gap-1">
        Sort
        <select class="rounded bg-dark-5 px-1 py-0.5 text-dark-0" bind:value={sort}>
          <option value="newest">Newest</option>
          <option value="score">Highest score</option>
        </select>
      </label>
      <label class="flex items-center gap-1">
        Any score ≥
        <input
          class="w-16 rounded bg-dark-5 px-1 py-0.5 text-dark-0"
          inputmode="decimal"
          bind:value={minScore}
        />
      </label>
    </div>

    {#await scans}
      <p class="mt-3 text-sm text-dark-2">Loading prompt scans…</p>
    {:then result}
      {@const rows = visible(result.items)}
      {@const capped = result.items.length >= limit}
      <p class="mt-3 text-xs text-dark-2">
        {num(rows.length)} of {num(result.items.length)} scanned prompts in the last {days} days{capped
          ? ` (capped at ${limit})`
          : ''}.
        {#if rows.length}
          <!-- Collapsed by default, like the blocked-prompt list: the text is explicit by definition,
               and the scores are what a moderator needs at a glance. -->
          <button
            type="button"
            class="ml-2 {LINK_CLASS}"
            onclick={() => {
              revealAll = !revealAll;
              revealed.clear();
            }}
          >
            {revealAll ? 'Hide all prompt text' : 'Show all prompt text'}
          </button>
        {/if}
      </p>
      <ul class="mt-2 space-y-2 text-sm">
        {#each rows as scan, i (`${scan.createdAt}:${i}`)}
          {@const open = revealAll || revealed.has(i)}
          <li class="rounded border border-dark-4 p-2">
            <div class="flex flex-wrap items-baseline gap-x-3 gap-y-1">
              <span class="text-xs text-dark-2">{dateTime(scan.createdAt)}</span>
              {#each scan.scores as s (s.label)}
                <span class="text-xs text-dark-0">{s.label} {s.score.toFixed(2)}</span>
              {/each}
              {#if !revealAll}
                <button
                  type="button"
                  class="text-xs {LINK_CLASS}"
                  onclick={() => (open ? revealed.delete(i) : revealed.add(i))}
                >
                  {open ? 'Hide prompt' : 'Show prompt'}
                </button>
              {/if}
            </div>
            {#if open}
              <p class="mt-1 wrap-break-word text-dark-0">{scan.prompt}</p>
              {#if scan.negativePrompt}
                <p class="wrap-break-word text-xs text-dark-2">negative: {scan.negativePrompt}</p>
              {/if}
            {/if}
          </li>
        {:else}
          <li class="text-sm text-dark-2">No scanned prompts in this window.</li>
        {/each}
      </ul>
    {:catch e}
      <p class="mt-3 text-sm text-red-300">Could not load prompt scans: {e.message}</p>
    {/await}
  {/if}
</section>
