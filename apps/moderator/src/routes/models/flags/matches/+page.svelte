<script lang="ts">
  import MatchesTriage from './MatchesTriage.svelte';
  import type { ActionData, PageData } from './$types';

  let { data, form }: { data: PageData; form: ActionData } = $props();
</script>

<MatchesTriage {data} {form} />
