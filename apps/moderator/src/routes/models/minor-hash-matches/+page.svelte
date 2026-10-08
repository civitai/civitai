<script lang="ts">
  import MinorFlagQueue from '$lib/components/minor-flags/MinorFlagQueue.svelte';
  import type { ActionData, PageData } from './$types';

  let { data, form }: { data: PageData; form: ActionData } = $props();
</script>

<header class="page-header">
  <h1>Minor Hash Matches</h1>
  <p>
    Models sharing a file hash with something a moderator flagged as depicting a minor, and what the
    scanner flagged on its own.
  </p>
</header>

<MinorFlagQueue {data} {form} />
