<script lang="ts" module>
  export type Cosmetic = {
    id: number;
    name: string;
    type: string;
    data: unknown;
    /** The creator's listing is awaiting approval: the shop cannot sell it yet. */
    inReview?: boolean;
  };
</script>

<script lang="ts">
  import { onDestroy } from 'svelte';
  import { Button } from '@civitai/ui/components/ui/button/index.js';
  import { Input } from '@civitai/ui/components/ui/input/index.js';
  import { cn } from '@civitai/ui/utils.js';
  import ItemThumb from './ItemThumb.svelte';
  import { humanize } from './shop-view';

  let {
    selected = $bindable(null),
    onpick,
  }: { selected?: Cosmetic | null; onpick?: (cosmetic: Cosmetic) => void } = $props();

  let query = $state('');
  let results = $state<Cosmetic[]>([]);
  let search = $state<'idle' | 'searching' | 'done' | 'error'>('idle');
  let timer: ReturnType<typeof setTimeout>;
  let searchSeq = 0;

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

  function pick(cosmetic: Cosmetic) {
    selected = cosmetic;
    onpick?.(cosmetic);
  }

  onDestroy(() => clearTimeout(timer));
</script>

<div class="flex flex-col gap-3">
  <input type="hidden" name="cosmeticId" value={selected?.id ?? ''} />
  {#if selected}
    <div class="flex items-center gap-3 rounded-lg border border-dark-4 bg-dark-7 p-2">
      <ItemThumb
        kind="cosmetic"
        name={selected.name}
        cosmeticType={selected.type}
        cosmeticData={selected.data}
      />
      <div class="min-w-0 flex-1">
        <p class="truncate text-sm text-white">{selected.name}</p>
        <p class="text-xs text-dark-2">{humanize(selected.type)} · #{selected.id}</p>
      </div>
      <Button type="button" size="sm" variant="ghost" onclick={() => (selected = null)}>Clear</Button>
    </div>
  {/if}
  <Input
    value={query}
    oninput={onSearch}
    placeholder="Search cosmetics by name"
    autocomplete="off"
    aria-label="Search cosmetics"
  />
  {#if search === 'searching'}
    <p class="text-sm text-dark-2">Searching…</p>
  {:else if search === 'error'}
    <p class="text-sm text-red-300">Could not search cosmetics. Try again.</p>
  {:else if search === 'done' && !results.length}
    <p class="text-sm text-dark-2">No cosmetics match.</p>
  {:else if search === 'idle' && !selected}
    <p class="text-sm text-dark-2">Type a name to see matching cosmetics.</p>
  {/if}
  {#if results.length}
    <ul class="grid max-h-72 grid-cols-3 gap-2 overflow-y-auto sm:grid-cols-4">
      {#each results as cosmetic (cosmetic.id)}
        <li>
          <button
            type="button"
            aria-pressed={selected?.id === cosmetic.id}
            disabled={cosmetic.inReview}
            title={cosmetic.inReview ? 'Still in review: players could not wear it yet.' : undefined}
            class={cn(
              'flex w-full flex-col items-center gap-1 rounded-lg border p-2 text-center hover:bg-dark-5',
              selected?.id === cosmetic.id
                ? 'border-blue-5 bg-blue-5/10 ring-1 ring-blue-5'
                : 'border-dark-4 bg-dark-7',
              cosmetic.inReview && 'cursor-not-allowed opacity-50 hover:bg-dark-7'
            )}
            onclick={() => pick(cosmetic)}
          >
            <ItemThumb
              kind="cosmetic"
              name={cosmetic.name}
              cosmeticType={cosmetic.type}
              cosmeticData={cosmetic.data}
              size="lg"
              class="w-full"
            />
            <span class="w-full truncate text-xs text-white">{cosmetic.name}</span>
            <span class="w-full truncate text-[11px] text-dark-2">
              {cosmetic.inReview ? 'In review' : humanize(cosmetic.type)}
            </span>
          </button>
        </li>
      {/each}
    </ul>
  {/if}
</div>
