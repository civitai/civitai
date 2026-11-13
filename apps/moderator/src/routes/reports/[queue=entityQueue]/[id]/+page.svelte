<script lang="ts">
  import type { PageData } from './$types';
  import EntityView from '../EntityView.svelte';

  let { data }: { data: PageData } = $props();
</script>

<EntityView {data} />
