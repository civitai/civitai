<script lang="ts">
  import NeedsReviewTriage from './NeedsReviewTriage.svelte';
  import type { ActionData, PageData } from './$types';

  let { data, form }: { data: PageData; form: ActionData } = $props();
</script>

<NeedsReviewTriage {data} {form} />
