<script lang="ts">
  import MetaChip from '$lib/components/minor-flags/MetaChip.svelte';

  let { label }: { label: 'minor' | 'poi' } = $props();
</script>

<MetaChip>{label === 'poi' ? 'real person' : 'minor'}</MetaChip>
