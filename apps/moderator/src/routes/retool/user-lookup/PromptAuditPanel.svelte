<script lang="ts">
  import { Badge } from '@civitai/ui/components/ui/badge/index.js';
  import { LINK_CLASS, dateTime, num } from '$lib/format';
  import type { Signals } from './signals';
  import ListFilterBar, { type FilterField } from '$lib/components/ListFilterBar.svelte';

  let { signals }: { signals: Promise<Signals> | null } = $props();

  let showPrompts = $state(false);

  // Retool's "Filter Prompt" and "# of Prompts". The count was hardcoded at 25, which is the wrong
  // default for the one question this panel answers — whether a pattern repeats.
  const FIELDS: FilterField[] = [
    { kind: 'search', key: 'q', label: 'Filter prompt' },
    {
      kind: 'select',
      key: 'n',
      label: '# of prompts',
      options: [
        ['25', '25'],
        ['50', '50'],
        ['100', '100'],
        ['500', '500'],
      ],
    },
  ];
  let filters = $state<Record<string, string>>({});
  const shownCount = $derived(Number(filters.n) || 25);

  // Negative prompts are searched too: an account whose blocked term sits in the negative is the same
  // finding, and Retool's filter matched both fields.
  const matching = <T extends { prompt: string | null; negativePrompt: string | null }>(
    rows: T[]
  ): T[] =>
    filters.q
      ? rows.filter((p) =>
          `${p.prompt ?? ''} ${p.negativePrompt ?? ''}`.toLowerCase().includes(filters.q.toLowerCase())
        )
      : rows;
</script>

<section class="mb-4 rounded-xl border border-dark-4 bg-dark-6 p-5">
  <h3 class="mb-3 text-sm font-semibold text-white">Prompt audit</h3>

  {#await signals}
    <p class="text-sm text-dark-2">Loading blocked prompts…</p>
  {:then result}
    {#if result}
      <p class="mb-3 text-xs text-dark-2">
        {num(result.generation.blockedTotal)} blocked prompts on this account.
      </p>

      {#if result.generation.blocked.length === 0}
        <p class="text-sm text-dark-2">None.</p>
      {:else if !showPrompts}
        <!-- Collapsed by default: these are prohibited prompts, so they are explicit by definition.
             The count is what a moderator needs at a glance; reading the text is a deliberate act,
             not something the page does to whoever is looking at the screen. -->
        <button type="button" class="text-sm {LINK_CLASS}" onclick={() => (showPrompts = true)}>
          Show blocked prompts
        </button>
      {:else}
        {@const matched = matching(result.generation.blocked)}
        <ListFilterBar
          fields={FIELDS}
          bind:values={filters}
          matched={matched.length}
          total={result.generation.blocked.length}
        />
        <ul class="space-y-1.5 text-sm">
          {#each matched.slice(0, shownCount) as p (p.key)}
            <li>
              <div class="flex flex-wrap items-baseline gap-x-2">
                <Badge variant="destructive">{p.source === 'External' ? 'OpenAI' : p.source}</Badge>
                <span class="text-xs text-dark-2">{dateTime(p.time)}</span>
              </div>
              <p class="wrap-break-word text-dark-0">{p.prompt}</p>
              {#if p.negativePrompt}
                <p class="wrap-break-word text-xs text-dark-2">negative: {p.negativePrompt}</p>
              {/if}
            </li>
          {/each}
        </ul>
        <button
          type="button"
          class="mt-2 block text-sm {LINK_CLASS}"
          onclick={() => (showPrompts = false)}
        >
          Hide prompts
        </button>
        {#if result.generation.blockedTotal > result.generation.blocked.length}
          <!-- Two different truncations: the SERVER capped what it sent, and the count control caps
               what is rendered. Reporting only the second would present a server cap as a total. -->
          <p class="mt-2 text-xs text-dark-2">
            {num(result.generation.blocked.length)} of {num(result.generation.blockedTotal)} loaded from
            the server.
          </p>
        {/if}
      {/if}
    {/if}
  {:catch}
    <p class="text-sm text-red-300">Could not load blocked prompts.</p>
  {/await}
</section>
