<script lang="ts">
  import { untrack } from 'svelte';
  import { SvelteMap } from 'svelte/reactivity';
  import { IconArrowDown, IconArrowUp, IconX } from '@tabler/icons-svelte';
  import * as Select from '@civitai/ui/components/ui/select/index.js';
  import * as Collapsible from '@civitai/ui/components/ui/collapsible/index.js';
  import { Button } from '@civitai/ui/components/ui/button/index.js';
  import { Input } from '@civitai/ui/components/ui/input/index.js';
  import EdgeMedia from '$lib/components/EdgeMedia.svelte';
  import { num, plural } from '$lib/format';
  import type { FlowReward } from '$lib/box-design';
  import {
    applyOneTier,
    applyPricePreset,
    groupByDesign,
    handPlacedCount,
    moveRewards,
    newTier,
    percent,
    placeByBands,
    removeRewards,
    type PriceBands,
    type TeamOdds,
    type TierPreset,
  } from '$lib/box-flow';
  import type { BoxDraft } from '$lib/mystery-box';
  import Chip from './Chip.svelte';
  import { FALLBACK_TIER_COLOR, teamColor } from './teams';

  let {
    draft = $bindable(),
    rewards,
    odds,
    bands = $bindable(),
    preset = $bindable(),
    focusTier = $bindable(),
  }: {
    draft: BoxDraft;
    rewards: SvelteMap<number, FlowReward>;
    odds: TeamOdds[];
    bands: PriceBands;
    preset: TierPreset;
    /** One-shot: the tray scrolls to it, flashes it, then clears it. */
    focusTier: string | null;
  } = $props();

  let newName = $state('');
  let newError = $state<string | null>(null);
  let flashed = $state<string | null>(null);
  let root: HTMLDivElement | undefined = $state();

  const groups = $derived(groupByDesign(draft.contents, rewards));
  const placedByHand = $derived(handPlacedCount(draft, rewards, bands));
  const reference = $derived(odds[0]);

  let flashTimer: ReturnType<typeof setTimeout> | undefined;
  $effect(() => {
    const key = focusTier;
    if (!key || !root) return;
    // Clearing `focusTier` re-runs this effect; the timer lives outside it so that re-run cannot cancel the flash.
    untrack(() => {
      root!.querySelector(`[data-tier="${CSS.escape(key)}"]`)?.scrollIntoView({ block: 'center', behavior: 'smooth' });
      flashed = key;
      focusTier = null;
      clearTimeout(flashTimer);
      flashTimer = setTimeout(() => (flashed = null), 1600);
    });
  });
  $effect(() => () => clearTimeout(flashTimer));

  function choose(next: TierPreset) {
    if (next === preset) return;
    if (next === 'price') Object.assign(draft, applyPricePreset(draft, rewards, bands));
    else if (next === 'one') Object.assign(draft, applyOneTier(draft));
    preset = next;
  }

  let bandText = $state<Record<keyof PriceBands, string | number>>(untrack(() => ({ uncommon: bands.uncommon, rare: bands.rare })));
  const setBand = (line: keyof PriceBands, raw: string) => {
    const value = Math.floor(Number(raw));
    if (value > 0) {
      bands[line] = value;
      if (preset === 'price') draft.contents = placeByBands(draft, rewards, bands);
    }
    bandText[line] = bands[line];
  };

  function addTier() {
    const made = newTier(draft.tiers, newName);
    if ('error' in made) {
      newError = made.error;
      return;
    }
    draft.tiers.push(made.tier);
    newName = '';
    newError = null;
    preset = 'custom';
  }

  function moveTier(index: number, by: -1 | 1) {
    const [tier] = draft.tiers.splice(index, 1);
    draft.tiers.splice(index + by, 0, tier);
  }

  const rowsOf = (key: string) => groups.filter((group) => group.tierKey === key);
  const idsOf = (group: { rows: { rewardDefinitionId: number }[] }) => new Set(group.rows.map((row) => row.rewardDefinitionId));
</script>

<div bind:this={root} class="space-y-3">
  <section class="rounded-xl border border-dark-4 bg-dark-6 p-5">
    <h2 class="mb-1 text-base font-semibold text-white">Tiers</h2>
    <p class="mb-3 text-xs text-dark-2">
      In draw order. A tier's chance is its weight over the weights of the tiers that have something for the buyer. Nothing is saved until you press Save.
    </p>
    <div class="mb-3 grid grid-cols-3 gap-1.5">
      <Chip size="default" pressed={preset === 'price'} onclick={() => choose('price')}>By shelf price</Chip>
      <Chip size="default" pressed={preset === 'one'} onclick={() => choose('one')}>One tier</Chip>
      <Chip size="default" pressed={preset === 'custom'} onclick={() => choose('custom')}>Custom</Chip>
    </div>
    {#if preset === 'price'}
      <div class="mb-3 grid grid-cols-2 gap-2 text-xs text-dark-2">
        <label>
          Uncommon up to
          <Input id="band-uncommon" class="mt-1" type="number" min="1" inputmode="numeric" bind:value={bandText.uncommon} onchange={(e) => setBand('uncommon', e.currentTarget.value)} />
        </label>
        <label>
          Rare up to
          <Input id="band-rare" class="mt-1" type="number" min="1" inputmode="numeric" bind:value={bandText.rare} onchange={(e) => setBand('rare', e.currentTarget.value)} />
        </label>
      </div>
      <p class="mb-3 text-xs text-dark-2">
        Cheaper on the shelf draws more often; above the Rare line is Legendary. An item with no shelf price is never placed for you.
        {#if placedByHand}
          <span class="text-amber-300">{placedByHand} placed by hand.</span>
          <Button size="sm" variant="outline" class="ml-1" onclick={() => (draft.contents = placeByBands(draft, rewards, bands))}>Re-sort by shelf price</Button>
        {/if}
      </p>
    {:else if preset === 'one'}
      <p class="mb-3 text-xs text-dark-2">Everything draws from one pool.</p>
    {:else}
      <p class="mb-3 text-xs text-dark-2">You place items yourself.</p>
    {/if}

    {#if draft.tiers.length === 0}
      <p class="rounded-lg border border-dark-4 p-4 text-center text-sm text-dark-2">No tiers yet. Choose a preset above or add one below.</p>
    {/if}

    {#each draft.tiers as tier, index (tier.key)}
      {@const stat = reference.tiers[index]}
      {@const designs = rowsOf(tier.key)}
      <div
        class="mb-3 rounded-lg border border-dark-4 bg-dark-7 p-3 transition-shadow {flashed === tier.key ? 'ring-2 ring-blue-5' : ''}"
        style:border-left="4px solid {tier.color ?? FALLBACK_TIER_COLOR}"
        data-tier={tier.key}
      >
        <div class="grid grid-cols-[1fr_88px] gap-2">
          <label class="text-xs text-dark-2">
            Name
            <Input class="mt-1 font-semibold" bind:value={tier.name} aria-label="Tier name" autocomplete="off" />
          </label>
          <label class="text-xs text-dark-2">
            Weight
            <Input
              class="mt-1"
              type="number"
              min="1"
              step="1"
              inputmode="numeric"
              aria-label="{tier.name || tier.key} weight"
              bind:value={() => tier.weight, (value) => (tier.weight = Math.max(0, Math.floor(Number(value)) || 0))}
            />
          </label>
        </div>
        <div class="my-2 h-1.5 overflow-hidden rounded-full bg-dark-5">
          <i class="block h-full" style:width="{stat.eligible ? stat.share * 100 : 0}%" style:background-color={tier.color ?? FALLBACK_TIER_COLOR}></i>
        </div>
        <div class="flex flex-wrap items-center justify-between gap-2 text-xs text-dark-2">
          <span>
            {#if stat.eligible}
              <b class="text-white">{percent(stat.share)}</b> chance
            {:else if tier.weight > 0 && designs.length}
              <span class="text-amber-300">Nothing here for {reference.team ?? 'this buyer'}</span>
            {:else}
              <span class="text-amber-300">Empty: drops out of the draw</span>
            {/if}
          </span>
          <span>{plural(designs.length, 'design')} · key <code>{tier.key}</code>{tier.id !== null ? ' (fixed)' : ''}</span>
        </div>

        {#if designs.length}
          <div class="mt-2 flex items-center">
            {#each designs.slice(0, 8) as group (group.id)}
              {#if group.imageUrl}
                <EdgeMedia src={group.imageUrl} width={64} alt="" class="-mr-1.5 size-6 rounded border border-dark-4 bg-dark-9 object-contain" />
              {/if}
            {/each}
            {#if designs.length > 8}<span class="ml-3 text-xs text-dark-2">+{designs.length - 8}</span>{/if}
          </div>
        {/if}

        <Collapsible.Root class="mt-2 border-t border-dark-5">
          <Collapsible.Trigger class="w-full py-2 text-left text-xs text-dark-2 hover:text-white">
            {designs.length ? 'Show items' : 'Empty: pick items on the other tab'}
          </Collapsible.Trigger>
          <Collapsible.Content>
            {#each designs as group (group.id)}
              <div class="grid grid-cols-[36px_1fr_auto] items-center gap-x-2 gap-y-0.5 border-t border-dark-5 py-2 first:border-t-0">
                <span class="row-span-2 size-9 overflow-hidden rounded border border-dark-5 bg-dark-9">
                  {#if group.imageUrl}<EdgeMedia src={group.imageUrl} width={72} alt="" class="size-full object-contain" />{/if}
                </span>
                <span class="truncate text-sm text-white">{group.design}</span>
                <Select.Root
                  type="single"
                  bind:value={() => group.tierKey, (to) => (draft.contents = moveRewards(draft.contents, idsOf(group), to).contents)}
                >
                  <Select.Trigger class="h-8 w-28 text-xs" aria-label="Move {group.design}">{tier.name || tier.key}</Select.Trigger>
                  <Select.Content>
                    {#each draft.tiers as option (option.key)}
                      <Select.Item value={option.key}>{option.name || option.key}</Select.Item>
                    {/each}
                  </Select.Content>
                </Select.Root>
                <span class="col-span-2 flex flex-wrap items-center gap-1.5 text-xs text-dark-2">
                  {group.shelf === null ? 'no price' : `${num(group.shelf)} Buzz`}
                  {#each group.rows as row, i (`${row.rewardDefinitionId}:${i}`)}
                    {@const team = rewards.get(row.rewardDefinitionId)?.team ?? null}
                    <button
                      type="button"
                      class="grid min-h-6 min-w-6 place-items-center rounded-full"
                      aria-pressed={row.enabled}
                      aria-label="{team ?? 'Every team'} variant {row.enabled ? 'on' : 'off'}"
                      title="{team ?? 'Every team'} {row.enabled ? '(on)' : '(off)'}"
                      onclick={() => (row.enabled = !row.enabled)}
                    >
                      <span class="size-2.5 rounded-full {row.enabled ? '' : 'opacity-25'}" style:background-color={teamColor(team)}></span>
                    </button>
                  {/each}
                  <Button
                    size="sm"
                    variant="ghost"
                    class="ml-auto h-7 w-8 p-0"
                    aria-label="Remove {group.design}"
                    onclick={() => (draft.contents = removeRewards(draft.contents, idsOf(group)))}
                  ><IconX size={14} /></Button>
                </span>
              </div>
            {/each}
          </Collapsible.Content>
        </Collapsible.Root>

        <div class="mt-1 flex items-center justify-between">
          <span class="flex items-center gap-1">
            <Button size="icon" variant="ghost" aria-label="Move tier up" disabled={index === 0} onclick={() => moveTier(index, -1)}><IconArrowUp size={16} /></Button>
            <Button size="icon" variant="ghost" aria-label="Move tier down" disabled={index === draft.tiers.length - 1} onclick={() => moveTier(index, 1)}><IconArrowDown size={16} /></Button>
            <input type="color" class="h-8 w-9 rounded border border-dark-4 bg-transparent" aria-label="{tier.name || tier.key} colour" bind:value={() => tier.color ?? FALLBACK_TIER_COLOR, (value) => (tier.color = value)} />
          </span>
          <Button
            size="sm"
            variant="destructive"
            disabled={designs.length > 0}
            title={designs.length ? 'Move or remove its items first' : 'Remove tier'}
            onclick={() => {
              draft.tiers = draft.tiers.filter((existing) => existing !== tier);
              preset = 'custom';
            }}
          >Remove tier</Button>
        </div>
      </div>
    {/each}

    <div class="flex items-start gap-2">
      <div class="flex-1">
        <Input
          placeholder="New tier name, e.g. Epic"
          aria-label="New tier name"
          bind:value={newName}
          autocomplete="off"
          onkeydown={(e) => e.key === 'Enter' && (e.preventDefault(), addTier())}
        />
        {#if newError}<p class="mt-1 text-xs text-amber-300">{newError}</p>{/if}
      </div>
      <Button variant="outline" onclick={addTier}>Add tier</Button>
    </div>
  </section>
</div>
