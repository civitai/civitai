<script lang="ts">
  import ReportsTable from './ReportsTable.svelte';
  import type { ActionData, PageData } from './$types';

  let { data, form }: { data: PageData; form: ActionData } = $props();
</script>

<!-- The shared table with its side panel, for every type that has not moved to a layout of its own.
     Models and users have (`/reports/model`, `/reports/user`): a queue, the item itself and its
     actions on one screen, built with the mods who work them. Each type moves over deliberately, when
     it is looked at, so a layout does not reshape a queue nobody has reviewed for it. -->
<ReportsTable {data} {form} />
