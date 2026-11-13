<script lang="ts">
  import ReportsTable from './ReportsTable.svelte';
  import type { PageData } from './$types';

  let { data }: { data: PageData } = $props();
</script>

<!-- The shared table with its side panel, for every type that has not moved to a layout of its own.
     Models, users and posts have (`/reports/model`, `/reports/user`, `/reports/post`): a queue, the
     item itself and its actions on one screen, built with the mods who work them. Images have the
     image queues' card grid (`/reports/image`). Each type moves over deliberately, when
     it is looked at, so a layout does not reshape a queue nobody has reviewed for it. -->
<ReportsTable {data} />
