<script lang="ts">
  import { onDestroy } from 'svelte';
  import { enhance } from '$app/forms';
  import { Button } from '@civitai/ui/components/ui/button/index.js';
  import { Checkbox } from '@civitai/ui/components/ui/checkbox/index.js';
  import { Input } from '@civitai/ui/components/ui/input/index.js';
  import * as Select from '@civitai/ui/components/ui/select/index.js';
  import { toast } from '@civitai/ui/components/ui/sonner/index.js';
  import CosmeticSample from '$lib/components/CosmeticSample.svelte';
  import ErrorAlert from '$lib/components/ErrorAlert.svelte';
  import { FormState } from '$lib/form-state.svelte';
  import { SHOP_TIERS } from '@civitai/shared/knights-shop';
  import LiveWarning from './LiveWarning.svelte';

  type Cosmetic = { id: number; name: string; type: string; data: unknown };
  type Kind = 'buzz_pack' | 'cosmetic' | 'membership';

  const KINDS: { value: Kind; label: string }[] = [
    { value: 'buzz_pack', label: 'Buzz pack' },
    { value: 'cosmetic', label: 'Cosmetic' },
    { value: 'membership', label: 'Membership' },
  ];

  let { ranks }: { ranks: readonly string[] } = $props();

  let kind = $state<Kind>('buzz_pack');
  let tier = $state<string>(SHOP_TIERS[0]);
  let minRank = $state('');
  let rotating = $state(false);
  let name = $state('');
  let cosmetic = $state<Cosmetic | null>(null);
  let query = $state('');
  let results = $state<Cosmetic[]>([]);
  let search = $state<'idle' | 'searching' | 'done' | 'error'>('idle');
  let timer: ReturnType<typeof setTimeout>;
  let searchSeq = 0;

  const add = new FormState({
    reload: true,
    onSuccess: () => {
      name = '';
      cosmetic = null;
      query = '';
      minRank = '';
      rotating = false;
      toast.success('Added');
    },
  });

  function stopSearch() {
    clearTimeout(timer);
    searchSeq++;
    results = [];
    search = 'idle';
  }

  function onSearch(e: Event) {
    query = (e.currentTarget as HTMLInputElement).value;
    stopSearch();
    const q = query.trim();
    if (!q) return;
    search = 'searching';
    const mine = searchSeq;
    timer = setTimeout(async () => {
      try {
        const res = await fetch(`/knights-of-new-order/shop/cosmetics?q=${encodeURIComponent(q)}`);
        if (!res.ok) throw new Error(String(res.status));
        const found: Cosmetic[] = await res.json();
        if (mine !== searchSeq) return;
        results = found;
        search = 'done';
      } catch {
        if (mine !== searchSeq) return;
        results = [];
        search = 'error';
      }
    }, 300);
  }

  function pick(c: Cosmetic) {
    cosmetic = c;
    if (!name.trim()) name = c.name;
    query = '';
    stopSearch();
  }

  onDestroy(() => clearTimeout(timer));
</script>

<section class="mb-6 rounded-xl border border-dark-4 bg-dark-6 p-5">
  <h2 class="mb-2 font-medium">Add an item</h2>
  <LiveWarning />
  {#if add.error}<ErrorAlert class="my-2" message={add.error} />{/if}
  <form method="POST" action="?/add" use:enhance={add.enhance} class="mt-2 flex flex-col gap-2">
    <div class="flex flex-wrap items-center gap-3 text-sm text-dark-2">
      <label class="flex items-center gap-2">
        Kind
        <input type="hidden" name="kind" value={kind} />
        <Select.Root type="single" bind:value={kind}>
          <Select.Trigger class="w-40">
            {KINDS.find((k) => k.value === kind)?.label}
          </Select.Trigger>
          <Select.Content>
            {#each KINDS as k (k.value)}<Select.Item value={k.value}>{k.label}</Select.Item>{/each}
          </Select.Content>
        </Select.Root>
      </label>

      {#if kind === 'buzz_pack'}
        <label class="flex items-center gap-2">
          Buzz <Input name="buzz" inputmode="numeric" required class="w-28" />
        </label>
      {:else if kind === 'membership'}
        <label class="flex items-center gap-2">
          Tier
          <input type="hidden" name="tier" value={tier} />
          <Select.Root type="single" bind:value={tier}>
            <Select.Trigger class="w-32">{tier}</Select.Trigger>
            <Select.Content>
              {#each SHOP_TIERS as t (t)}<Select.Item value={t}>{t}</Select.Item>{/each}
            </Select.Content>
          </Select.Root>
        </label>
        <label class="flex items-center gap-2">
          Months <Input name="months" value="1" readonly class="w-20" />
          <span class="text-xs">The shop sells memberships one month at a time.</span>
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
          {#if search === 'searching'}
            <p>Searching…</p>
          {:else if search === 'error'}
            <p class="text-red-300">Could not search cosmetics. Try again.</p>
          {:else if search === 'done' && !results.length}
            <p>No cosmetics match</p>
          {/if}
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
        <input type="hidden" name="minRank" value={minRank} />
        <Select.Root type="single" bind:value={minRank}>
          <Select.Trigger class="w-36">{minRank || 'Anyone'}</Select.Trigger>
          <Select.Content>
            <Select.Item value="">Anyone</Select.Item>
            {#each ranks as rank (rank)}<Select.Item value={rank}>{rank}</Select.Item>{/each}
          </Select.Content>
        </Select.Root>
      </label>
      <label class="flex items-center gap-2">
        <input type="hidden" name="rotating" value={rotating ? 'on' : ''} />
        <Checkbox bind:checked={rotating} /> Rotating
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
