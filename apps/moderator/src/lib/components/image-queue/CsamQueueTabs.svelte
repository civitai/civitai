<script lang="ts">
  import LinkTabs from '$lib/components/LinkTabs.svelte';

  let { active, level }: { active: 'all' | 'user'; level: number } = $props();

  const items = $derived([
    { value: 'all', label: 'All images', href: `/images/csam?level=${level}` },
    { value: 'user', label: 'By user', href: `/images/csam?by=user&level=${level}` },
  ]);
</script>

<LinkTabs {items} {active} />
