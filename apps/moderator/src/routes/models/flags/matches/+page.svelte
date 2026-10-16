<script lang="ts">
  import MinorFlagQueue from '$lib/components/minor-flags/MinorFlagQueue.svelte';
  import ModelFlagsTabs from '../ModelFlagsTabs.svelte';
  import type { ActionData, PageData } from './$types';

  let { data, form }: { data: PageData; form: ActionData } = $props();
</script>

<header class="page-header">
  <h1>Model Flags</h1>
  <p>Models sharing a file hash with something a moderator flagged as depicting a minor.</p>
</header>

<div class="mb-4"><ModelFlagsTabs /></div>

<MinorFlagQueue {data} {form} />
