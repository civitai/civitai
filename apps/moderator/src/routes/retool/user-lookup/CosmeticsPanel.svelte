<script lang="ts">
  import { enhance } from '$app/forms';
  import type { SubmitFunction } from '@sveltejs/kit';
  import { Badge } from '@civitai/ui/components/ui/badge/index.js';
  import { Button } from '@civitai/ui/components/ui/button/index.js';
  import type { Account } from './user-account';
  import type { FormResult } from './form-result';
  import ListCard from './ListCard.svelte';

  let {
    account,
    userId,
    canAct,
    form,
    onSubmit,
    submitting,
  }: {
    account: Promise<Account> | null;
    userId: number;
    canAct: boolean;
    form: FormResult;
    onSubmit: SubmitFunction;
    submitting: boolean;
  } = $props();

  const error = $derived(form?.scope === 'cosmetics' ? form.error : null);
</script>

{#if error}
  <div
    class="mb-4 rounded-md border border-red-500/30 bg-red-500/10 p-2 text-sm text-red-300"
    role="alert"
  >
    {error}
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
                <form method="POST" action="?/removeCosmetic" use:enhance={onSubmit}>
                  <input type="hidden" name="userId" value={userId} />
                  <input type="hidden" name="cosmeticId" value={c.cosmeticId} />
                  <input type="hidden" name="claimKey" value={c.claimKey} />
                  <Button type="submit" size="xs" variant="destructive" disabled={submitting}>
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
