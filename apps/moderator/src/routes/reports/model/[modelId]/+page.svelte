<script lang="ts">
  import type { PageData } from './$types';
  import ModelReport from '../ModelReport.svelte';

  let { data }: { data: PageData } = $props();
</script>

<ModelReport {data} />
