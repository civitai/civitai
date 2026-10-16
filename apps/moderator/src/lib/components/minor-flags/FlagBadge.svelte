<script lang="ts">
  import MetaChip from '$lib/components/minor-flags/MetaChip.svelte';

  let {
    label,
    size = 'sm',
  }: { label: 'minor' | 'poi'; size?: 'sm' | 'md' } = $props();
</script>

<MetaChip {size}>{label === 'poi' ? 'real person' : 'minor'}</MetaChip>
