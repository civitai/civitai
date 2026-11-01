<script lang="ts">
  import FlowShell from './FlowShell.svelte';
  import type { PageData } from './$types';

  let { data }: { data: PageData } = $props();
</script>

<!-- The page component is reused when the URL moves from one box's flow to another's; keying on the id gives the new box fresh UI state. -->
{#key data.box.id}
  <FlowShell {data} />
{/key}
