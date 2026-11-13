<script lang="ts">
  import EdgeMedia from '$lib/components/EdgeMedia.svelte';
  import { num } from '$lib/format';
  import { isDefined, type CatalogDesign } from '$lib/box-design';
  import type { DraftTier } from '$lib/mystery-box';
  import { teamColor } from './teams';

  let {
    design,
    selected,
    eligible,
    inBox,
    tier,
    typeLabel,
    onclick,
  }: {
    design: CatalogDesign;
    selected: boolean;
    /** False for an event design in a box of another event: nobody on the box's teams could draw it. */
    eligible: boolean;
    inBox: number;
    /** The one tier the design sits in, when it sits in just one. */
    tier: DraftTier | undefined;
    typeLabel: string;
    onclick: () => void;
  } = $props();

  const image = $derived(design.variants.find((variant) => variant.url)?.url);
</script>

<button
  type="button"
  class="flex min-w-0 flex-col gap-1.5 rounded-lg border bg-dark-7 p-2 text-left transition-colors hover:border-dark-3 disabled:cursor-not-allowed disabled:opacity-40 {selected ? 'border-blue-5 bg-blue-9/20' : 'border-dark-4'}"
  aria-pressed={selected}
  disabled={!eligible}
  {onclick}
>
  <span class="relative block aspect-square overflow-hidden rounded-md border border-dark-5 bg-dark-9">
    {#if image}
      <EdgeMedia src={image} width={240} alt="" class="size-full object-contain" />
    {:else}
      <span class="grid size-full place-items-center text-xs text-dark-2">no image</span>
    {/if}
    <span class="absolute top-1.5 left-1.5 grid size-5 place-items-center rounded border text-xs text-white {selected ? 'border-blue-5 bg-blue-5' : 'border-dark-3 bg-dark-9/80'}">
      {selected ? '✓' : ''}
    </span>
  </span>
  <span class="line-clamp-2 text-sm leading-tight font-semibold text-white">{design.name}</span>
  <span class="flex items-center justify-between gap-1 text-xs text-dark-2">
    <span>{design.shelf === null ? 'No shelf price' : `${num(design.shelf)} Buzz`}</span>
    <span class="flex gap-0.5">
      {#each design.variants as variant (variant.cosmeticId)}
        <span class="size-2 rounded-full" style:background-color={teamColor(variant.team)} title={variant.team ?? 'every team'}></span>
      {/each}
    </span>
  </span>
  <span class="text-xs text-dark-2">{typeLabel}{design.variants.length > 1 ? ` × ${design.variants.length}` : ''}</span>
  <span class="flex flex-wrap items-start gap-1">
    {#if inBox}
      <span class="rounded px-1.5 text-xs text-white" style:background-color={tier?.color ?? '#5c5f66'}>
        {tier ? `In ${tier.name || tier.key}` : 'In several tiers'}
      </span>
    {/if}
    {#if !isDefined(design)}
      <span class="rounded border border-dashed border-amber-400/60 px-1.5 text-xs text-amber-300">Needs a definition</span>
    {/if}
    {#if !eligible}
      <span class="rounded border border-red-400/40 px-1.5 text-xs text-red-300">Needs event {design.event}</span>
    {/if}
  </span>
</button>
