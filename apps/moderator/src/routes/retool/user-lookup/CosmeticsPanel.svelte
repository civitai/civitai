<script lang="ts">
  import { FormState } from '$lib/form-state.svelte';
  import { enhance } from '$app/forms';
  import { Badge } from '@civitai/ui/components/ui/badge/index.js';
  import { Button } from '@civitai/ui/components/ui/button/index.js';
  import type { Account } from './user-account';
  import ListCard from './ListCard.svelte';

  let {
    account,
    userId,
    canAct,
    onSuccess,
  }: {
    account: Promise<Account> | null;
    userId: number;
    canAct: boolean;
    onSuccess: () => void;
  } = $props();

  // Called through, not captured: reading the prop inside the closure is what stops a re-passed
  // callback being ignored (svelte’s `state_referenced_locally`).
  const form = new FormState({ onSuccess: () => onSuccess() });
</script>

{#if form.error}
  <div
    class="mb-4 rounded-md border border-red-500/30 bg-red-500/10 p-2 text-sm text-red-300"
    role="alert"
  >
    {form.error}
  </div>
{/if}

{#await account}
  <div class="rounded-xl border border-dark-4 bg-dark-6 p-5">
    <p class="text-sm text-dark-2">Loading cosmetics…</p>
  </div>
{:then result}
  {#if result}
    <ListCard
      title="Cosmetics"
      total={result.cosmetics.items.length}
      capped={result.cosmetics.truncated}
      shown={10}
      hint="Removing takes back this claim only — a cosmetic held twice keeps its other claim. Equipped items are unequipped by the removal."
    >
      {#snippet children(limit)}
        <ul class="space-y-1 text-sm">
          {#each result.cosmetics.items.slice(0, limit) as c (c.key)}
            <li class="flex flex-wrap items-baseline gap-x-2">
              <span class="text-dark-0">{c.name}</span>
              <Badge variant="secondary">{c.type}</Badge>
              {#if c.equipped}<span class="text-xs text-dark-2">equipped</span>{/if}
              {#if canAct}
                <form method="POST" action="?/removeCosmetic" use:enhance={form.enhance}>
                  <input type="hidden" name="userId" value={userId} />
                  <input type="hidden" name="cosmeticId" value={c.cosmeticId} />
                  <input type="hidden" name="claimKey" value={c.claimKey} />
                  <Button type="submit" size="xs" variant="destructive" disabled={form.submitting}>
                    Remove
                  </Button>
                </form>
              {/if}
            </li>
          {/each}
        </ul>
      {/snippet}
    </ListCard>
  {/if}
{:catch}
  <div class="rounded-xl border border-dark-4 bg-dark-6 p-5">
    <p class="text-sm text-red-300">Could not load cosmetics.</p>
  </div>
{/await}
