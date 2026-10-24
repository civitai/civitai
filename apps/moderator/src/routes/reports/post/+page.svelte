<script lang="ts">
  import type { PageData } from './$types';
  import PostView from './PostView.svelte';

  let { data }: { data: PageData } = $props();
</script>

<PostView {data} />
