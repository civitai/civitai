<script lang="ts">
  import { IconCoins, IconLock } from '@tabler/icons-svelte';
  import { Badge } from '@civitai/ui/components/ui/badge/index.js';
  import { cn } from '@civitai/ui/utils.js';
  import { num } from '$lib/format';
  import ItemThumb from './ItemThumb.svelte';
  import { DEAL_LABEL, secondaryLine, type CardModel } from './shop-view';

  let { card, variant = 'compact' }: { card: CardModel; variant?: 'deal' | 'compact' } = $props();

  const detail = $derived(
    secondaryLine({
      kind: card.kind,
      name: card.name,
      price: card.listPrice ?? card.price,
      buzz: card.buzz,
      tier: card.tier,
      days: 7,
      cosmeticId: null,
      cosmeticType: card.cosmeticType,
    })
  );
</script>

<article
  class={cn(
    'flex gap-3 rounded-lg border bg-dark-7 p-3',
    card.hidden ? 'border-dashed border-red-500/40' : card.listPrice ? 'border-amber-500/40' : 'border-dark-4',
    variant === 'deal' && 'bg-gradient-to-br from-amber-500/10 to-dark-7'
  )}
>
  <ItemThumb
    kind={card.kind}
    name={card.name}
    tier={card.tier}
    cosmeticType={card.cosmeticType}
    cosmeticData={card.cosmeticData}
    size={variant === 'deal' ? 'lg' : 'md'}
  />
  <div class="flex min-w-0 flex-1 flex-col justify-between gap-1">
    <div class="min-w-0">
      <p class="truncate text-sm font-medium text-white">{card.name}</p>
      {#if detail}<p class="truncate text-xs text-dark-2">{detail}</p>{/if}
    </div>
    <div class="flex flex-wrap items-center gap-x-2 gap-y-1 text-sm">
      <span class="inline-flex items-center gap-1 font-semibold tabular-nums text-amber-300">
        <IconCoins class="size-4" />
        {card.price === null ? '—' : num(card.price)}
      </span>
      {#if card.listPrice !== null}
        <s class="text-xs tabular-nums text-dark-2">{num(card.listPrice)}</s>
        <Badge class="border-transparent bg-amber-500/15 text-amber-300">{DEAL_LABEL}</Badge>
      {/if}
      {#if card.minRank}
        <span class="inline-flex items-center gap-1 text-xs text-dark-2">
          <IconLock class="size-3" />
          {card.minRank}+
        </span>
      {/if}
    </div>
    {#if card.hidden}
      <p class="text-xs text-red-300">Hidden from players: {card.hidden}</p>
    {/if}
  </div>
</article>
