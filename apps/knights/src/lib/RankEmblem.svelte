<script lang="ts">
  import Icon from './Icon.svelte';

  type Size = 'sm' | 'md' | 'lg';
  let { rank, size = 'md', dim = false }: { rank: string; size?: Size; dim?: boolean } = $props();

  const ICONS = { Acolyte: 'flame', Knight: 'sword', Templar: 'shield', Paladin: 'crown' } as const;
  const DIAMETER = { sm: 56, md: 70, lg: 76 } as const;
  const icon = $derived(ICONS[rank as keyof typeof ICONS] ?? 'shield');
</script>

<span
  class="emblem"
  class:dim
  style:width="{DIAMETER[size]}px"
  style:height="{DIAMETER[size]}px"
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
  .dim {
    border-color: var(--io-gold-muted);
    color: var(--io-gold-muted);
  }
</style>
