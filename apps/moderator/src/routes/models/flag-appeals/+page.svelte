<script lang="ts">
  import MinorFlagQueue from '$lib/components/minor-flags/MinorFlagQueue.svelte';
  import type { ActionData, PageData } from './$types';

  let { data, form }: { data: PageData; form: ActionData } = $props();
</script>

<header class="page-header">
  <h1>Model Flag Appeals</h1>
  <p>
    Owners contesting a model flagged as depicting a minor or a real person, whether the flag came
    from a hash match, the text scan or a moderator.
  </p>
</header>

<MinorFlagQueue {data} {form} />
