<script lang="ts">
  import type { ComponentProps } from 'svelte';
  import { useElementsUi } from '$lib/elements-ui';
  import AppHeader from './AppHeader.svelte';
  import AppHeaderElements from './AppHeaderElements.svelte';

  let props: ComponentProps<typeof AppHeader> = $props();
  const elementsUi = useElementsUi();
</script>

{#if elementsUi()}
  <AppHeaderElements {...props} />
{:else}
  <AppHeader {...props} />
{/if}
