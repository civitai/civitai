<script lang="ts">
  import MinorFlagQueue from '$lib/components/minor-flags/MinorFlagQueue.svelte';
  import type { ActionData, PageData } from './$types';

  let { data, form }: { data: PageData; form: ActionData } = $props();
</script>

<MinorFlagQueue {data} {form} />
