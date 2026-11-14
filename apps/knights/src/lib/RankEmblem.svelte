<script lang="ts">
  import Icon from './Icon.svelte';

  type Size = 'xs' | 'sm' | 'md' | 'lg';
  let {
    rank,
    size = 'md',
    dim = false,
    fill = false,
  }: { rank: string; size?: Size; dim?: boolean; fill?: boolean } = $props();

  const ICONS = { Acolyte: 'flame', Knight: 'sword', Templar: 'shield', Paladin: 'crown' } as const;
  const DIAMETER = { xs: 24, sm: 56, md: 70, lg: 76 } as const;
  const icon = $derived(ICONS[rank as keyof typeof ICONS] ?? 'shield');
</script>

<span
  class="emblem"
  class:dim
  class:fill
  style:width={fill ? undefined : `${DIAMETER[size]}px`}
  style:height={fill ? undefined : `${DIAMETER[size]}px`}
  aria-hidden="true"
>
  <Icon name={icon} size={Math.round(DIAMETER[size] * 0.42)} />
</span>

<style>
  .emblem {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    flex: none;
    border: 1.5px solid var(--io-gold);
    border-radius: 50%;
    background: var(--io-surface);
    color: var(--io-gold);
  }
  /* Fills a box the parent sizes, e.g. a badge circle; the icon scales with it. */
  .fill {
    width: 100%;
    height: 100%;
  }
  .fill :global(svg) {
    width: 60%;
    height: 60%;
  }
  .dim {
    border-color: var(--io-gold-muted);
    color: var(--io-gold-muted);
  }
</style>
