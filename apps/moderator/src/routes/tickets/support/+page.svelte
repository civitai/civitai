<script lang="ts">
  import TicketTriage from '../TicketTriage.svelte';
  import type { ActionData, PageData } from './$types';

  let { data, form }: { data: PageData; form: ActionData } = $props();
</script>

<TicketTriage {data} {form} />
