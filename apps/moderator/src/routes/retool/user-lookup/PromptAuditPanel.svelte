<script lang="ts">
  import { Badge } from '@civitai/ui/components/ui/badge/index.js';
  import { LINK_CLASS, dateTime, num } from '$lib/format';
  import type { Signals } from './signals';

  let { signals }: { signals: Promise<Signals> | null } = $props();

  const SHOWN = 25;
  let showPrompts = $state(false);
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
          Show {Math.min(SHOWN, result.generation.blocked.length)} blocked prompts
        </button>
      {:else}
        <ul class="space-y-1.5 text-sm">
          {#each result.generation.blocked.slice(0, SHOWN) as p (p.key)}
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
        {#if result.generation.blockedTotal > Math.min(SHOWN, result.generation.blocked.length)}
          <p class="mt-2 text-xs text-dark-2">
            Showing {Math.min(SHOWN, result.generation.blocked.length)} of {num(
              result.generation.blockedTotal
            )}.
          </p>
        {/if}
      {/if}
    {/if}
  {:catch}
    <p class="text-sm text-red-300">Could not load blocked prompts.</p>
  {/await}
</section>
