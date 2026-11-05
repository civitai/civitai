<script lang="ts">
  import { enhance } from '$app/forms';
  import { invalidateAll } from '$app/navigation';
  import { Button } from '@civitai/ui/components/ui/button/index.js';
  import { Input } from '@civitai/ui/components/ui/input/index.js';
  import { toast } from '@civitai/ui/components/ui/sonner/index.js';
  import CosmeticSample from '$lib/components/CosmeticSample.svelte';
  import ErrorAlert from '$lib/components/ErrorAlert.svelte';
  import { FormState } from '$lib/form-state.svelte';
  import { NewOrderRankType } from '@civitai/db-schema/enums';
  import { SHOP_TIERS } from '@civitai/shared/knights-shop';
  import LiveWarning from './LiveWarning.svelte';

  type Cosmetic = { id: number; name: string; type: string; data: unknown };

  let kind = $state<'buzz_pack' | 'cosmetic' | 'membership'>('buzz_pack');
  let name = $state('');
  let cosmetic = $state<Cosmetic | null>(null);
  let query = $state('');
  let results = $state<Cosmetic[]>([]);
  let timer: ReturnType<typeof setTimeout>;

  const add = new FormState({
    onSuccess: () => {
      name = '';
      cosmetic = null;
      query = '';
      void invalidateAll();
      toast.success('Added, live now');
    },
  });

  function onSearch(e: Event) {
    query = (e.currentTarget as HTMLInputElement).value;
    clearTimeout(timer);
    const q = query.trim();
    if (!q) {
      results = [];
      return;
    }
    timer = setTimeout(async () => {
      const res = await fetch(`/knights-of-new-order/shop/cosmetics?q=${encodeURIComponent(q)}`);
      results = res.ok ? await res.json() : [];
    }, 300);
  }

  function pick(c: Cosmetic) {
    cosmetic = c;
    if (!name.trim()) name = c.name;
    query = '';
    results = [];
  }
</script>

<section class="mb-6 rounded-xl border border-dark-4 bg-dark-6 p-5">
  <h2 class="mb-2 font-medium">Add an item</h2>
  <LiveWarning />
  {#if add.error}<ErrorAlert class="my-2" message={add.error} />{/if}
  <form method="POST" action="?/add" use:enhance={add.enhance} class="mt-2 flex flex-col gap-2">
    <div class="flex flex-wrap items-center gap-3 text-sm text-dark-2">
      <label class="flex items-center gap-2">
        Kind
        <select
          name="kind"
          bind:value={kind}
          class="h-8 rounded-md border bg-background px-2 text-sm"
        >
          <option value="buzz_pack">Buzz pack</option>
          <option value="cosmetic">Cosmetic</option>
          <option value="membership">Membership</option>
        </select>
      </label>

      {#if kind === 'buzz_pack'}
        <label class="flex items-center gap-2">
          Buzz <Input name="buzz" inputmode="numeric" required class="w-28" />
        </label>
      {:else if kind === 'membership'}
        <label class="flex items-center gap-2">
          Tier
          <select name="tier" required class="h-8 rounded-md border bg-background px-2 text-sm">
            {#each SHOP_TIERS as tier (tier)}<option value={tier}>{tier}</option>{/each}
          </select>
        </label>
        <label class="flex items-center gap-2">
          Months <Input name="months" inputmode="numeric" required value="1" class="w-20" />
        </label>
      {/if}
    </div>

    {#if kind === 'cosmetic'}
      <div class="flex flex-col gap-2 text-sm text-dark-2">
        <input type="hidden" name="cosmeticId" value={cosmetic?.id ?? ''} />
        {#if cosmetic}
          <div class="flex items-center gap-3">
            <CosmeticSample type={cosmetic.type} name={cosmetic.name} data={cosmetic.data} />
            <span>{cosmetic.name} ({cosmetic.type}, #{cosmetic.id})</span>
            <Button type="button" size="sm" variant="outline" onclick={() => (cosmetic = null)}>
              Change
            </Button>
          </div>
        {:else}
          <Input
            value={query}
            oninput={onSearch}
            placeholder="Search cosmetics by name"
            class="w-80"
            autocomplete="off"
          />
          {#if results.length}
            <ul class="max-h-64 w-80 overflow-auto rounded-md border border-dark-4">
              {#each results as c (c.id)}
                <li>
                  <button
                    type="button"
                    class="flex w-full items-center gap-3 px-2 py-1 text-left hover:bg-dark-5"
                    onclick={() => pick(c)}
                  >
                    <CosmeticSample type={c.type} name={c.name} data={c.data} />
                    <span>{c.name} <span class="text-xs">({c.type})</span></span>
                  </button>
                </li>
              {/each}
            </ul>
          {/if}
        {/if}
      </div>
    {/if}

    <div class="flex flex-wrap items-center gap-3 text-sm text-dark-2">
      <label class="flex items-center gap-2">
        Name <Input name="name" required bind:value={name} class="w-56" />
      </label>
      <label class="flex items-center gap-2">
        Price (gold) <Input name="price" inputmode="numeric" required class="w-28" />
      </label>
      <label class="flex items-center gap-2">
        Sort order <Input name="sortOrder" inputmode="numeric" required value="0" class="w-24" />
      </label>
      <label class="flex items-center gap-2">
        Minimum rank
        <select name="minRank" class="h-8 rounded-md border bg-background px-2 text-sm">
          <option value="">Anyone</option>
          {#each Object.values(NewOrderRankType) as rank (rank)}<option value={rank}>{rank}</option>{/each}
        </select>
      </label>
      <label class="flex items-center gap-2">
        <input type="checkbox" name="rotating" /> Rotating
      </label>
    </div>
    <label class="flex items-center gap-2 text-sm text-dark-2">
      Description <Input name="description" class="flex-1" />
    </label>
    <div>
      <Button type="submit" size="sm" disabled={add.submitting || (kind === 'cosmetic' && !cosmetic)}>
        Add
      </Button>
    </div>
  </form>
</section>
