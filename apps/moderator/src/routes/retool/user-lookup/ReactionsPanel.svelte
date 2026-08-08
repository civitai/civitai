<script lang="ts">
  import { LINK_CLASS, num } from '$lib/format';
  import type { Account } from './user-account';

  let { account }: { account: Promise<Account> | null } = $props();
</script>

<section class="mb-4 rounded-xl border border-dark-4 bg-dark-6 p-5">
  {#await account}
    <p class="text-sm text-dark-2">Loading reactions…</p>
  {:then result}
    {#if result}
      <h3 class="mb-1 text-sm font-semibold text-white">
        Image reactions given ({num(result.reactions.total)})
      </h3>
      <p class="mb-3 text-xs text-dark-2">
        Creators reacted to most, across {num(result.reactions.creators)}
        {result.reactions.creators === 1 ? 'creator' : 'creators'}. Concentration on one is the
        signal. Images only — article and comment reactions are not counted.
      </p>
      {#if result.reactions.targets.length === 0}
        <p class="text-sm text-dark-2">None.</p>
      {:else}
        <ul class="space-y-1 text-sm">
          {#each result.reactions.targets as t (t.userId)}
            <li class="flex flex-wrap items-baseline gap-x-2">
              <span class="tabular-nums text-dark-0">{num(t.count)}</span>
              <a href="?q={t.userId}" class={LINK_CLASS}>{t.username ?? `#${t.userId}`}</a>
            </li>
          {/each}
        </ul>
        {#if result.reactions.creators > result.reactions.targets.length}
          <p class="mt-2 text-xs text-dark-2">
            Top {result.reactions.targets.length} of {num(result.reactions.creators)}.
          </p>
        {/if}
      {/if}
    {/if}
  {:catch}
    <p class="text-sm text-red-300">Could not load reactions.</p>
  {/await}
</section>
