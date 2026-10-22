<script lang="ts">
  import AppealTriage from './AppealTriage.svelte';
  import type { ActionData, PageData } from './$types';

  let { data, form }: { data: PageData; form: ActionData } = $props();
</script>

<AppealTriage {data} {form} />
