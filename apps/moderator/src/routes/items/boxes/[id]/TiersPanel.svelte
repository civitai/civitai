<script lang="ts">
  import { IconArrowDown, IconArrowUp, IconTrash } from '@tabler/icons-svelte';
  import { Button } from '@civitai/ui/components/ui/button/index.js';
  import { Input } from '@civitai/ui/components/ui/input/index.js';
  import { TIER_KEY_PATTERN, type BoxDraft } from '$lib/mystery-box';

  let { draft = $bindable() }: { draft: BoxDraft } = $props();

  let newKey = $state('');
  const keyProblem = $derived(
    !newKey
      ? null
      : !TIER_KEY_PATTERN.test(newKey)
        ? 'Lowercase letters, digits and dashes.'
        : draft.tiers.some((tier) => tier.key === newKey)
          ? 'This box already has that key.'
          : null
  );
  const totalWeight = $derived(draft.tiers.reduce((sum, tier) => sum + (tier.weight || 0), 0));
  const contentCount = (key: string) => draft.contents.filter((c) => c.tierKey === key).length;

  function addTier() {
    if (!newKey || keyProblem) return;
    const name = newKey.charAt(0).toUpperCase() + newKey.slice(1).replace(/-/g, ' ');
    draft.tiers.push({ id: null, key: newKey, name, weight: 1, color: null });
    newKey = '';
  }

  function move(index: number, by: -1 | 1) {
    const [tier] = draft.tiers.splice(index, 1);
    draft.tiers.splice(index + by, 0, tier);
  }
</script>

<section class="rounded-xl border border-dark-4 bg-dark-6 p-5">
  <h2 class="mb-1 text-base font-semibold text-white">Tiers</h2>
  <p class="mb-3 text-xs text-dark-2">
    In draw order. A tier's chance is its weight over the weights of the tiers with anything left for
    the buyer. A tier's key names it in the odds history and can't change once saved.
  </p>

  {#if draft.tiers.length}
    <div class="space-y-2">
      {#each draft.tiers as tier, i (tier.key)}
        <div class="grid items-center gap-2 md:grid-cols-[110px_1fr_110px_70px_70px_auto]">
          <code class="truncate text-xs text-dark-2" title={tier.key}>{tier.key}</code>
          <Input aria-label="{tier.key} name" bind:value={tier.name} />
          <Input
            aria-label="{tier.key} weight"
            type="number"
            min="1"
            step="1"
            bind:value={() => tier.weight, (v) => (tier.weight = Number(v))}
          />
          <input
            aria-label="{tier.key} colour"
            type="color"
            class="h-9 w-full rounded border border-dark-4 bg-transparent"
            bind:value={() => tier.color ?? '#9ca3af', (v) => (tier.color = v)}
          />
          <span class="text-xs text-dark-2">
            {totalWeight > 0 && tier.weight > 0
              ? `${((tier.weight / totalWeight) * 100).toFixed(1)}%`
              : '—'}
          </span>
          <div class="flex gap-1">
            <Button size="icon" variant="ghost" aria-label="Move up" disabled={i === 0} onclick={() => move(i, -1)}>
              <IconArrowUp size={16} />
            </Button>
            <Button
              size="icon"
              variant="ghost"
              aria-label="Move down"
              disabled={i === draft.tiers.length - 1}
              onclick={() => move(i, 1)}
            >
              <IconArrowDown size={16} />
            </Button>
            <Button
              size="icon"
              variant="ghost"
              aria-label="Remove tier"
              title={contentCount(tier.key) ? 'Move or remove its contents first' : 'Remove tier'}
              disabled={contentCount(tier.key) > 0}
              onclick={() => draft.tiers.splice(i, 1)}
            >
              <IconTrash size={16} />
            </Button>
          </div>
        </div>
      {/each}
    </div>
    <p class="mt-2 text-xs text-dark-2">Percentages are for a buyer with something left in every tier.</p>
  {:else}
    <p class="text-sm text-dark-2">No tiers yet.</p>
  {/if}

  <div class="mt-4 flex items-start gap-2">
    <div>
      <Input
        aria-label="New tier key"
        placeholder="new tier key, e.g. legendary"
        class="w-64"
        bind:value={newKey}
        onkeydown={(e) => e.key === 'Enter' && (e.preventDefault(), addTier())}
      />
      {#if keyProblem}
        <p class="mt-1 text-xs text-red-300">{keyProblem}</p>
      {/if}
    </div>
    <Button variant="outline" disabled={!newKey || !!keyProblem} onclick={addTier}>Add tier</Button>
  </div>
</section>
