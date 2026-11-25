<script lang="ts">
  import { isMatureNsfwLevel, nsfwLevelLabel } from '$lib/nsfw-rating';

  let { level, class: className = '' }: { level: string | null | undefined; class?: string } = $props();

  const label = $derived(nsfwLevelLabel(level));
</script>

{#if label}
  <span
    class="rounded px-1.5 py-0.5 font-mono text-xs font-semibold {isMatureNsfwLevel(level)
      ? 'bg-buzz text-black'
      : 'bg-black/60 text-on-accent'} {className}"
    title="Rated {label}">{label}</span
  >
{/if}
