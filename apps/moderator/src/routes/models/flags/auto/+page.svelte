<script lang="ts">
  import FlaggedTriage from './FlaggedTriage.svelte';
  import type { ActionData, PageData } from './$types';

  let { data, form }: { data: PageData; form: ActionData } = $props();
</script>

<FlaggedTriage {data} {form} />
