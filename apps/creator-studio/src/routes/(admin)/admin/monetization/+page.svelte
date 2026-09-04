<script lang="ts">
  import RangeSelector from '$lib/components/RangeSelector.svelte';
  import { formatRange } from '$lib/date-range';
  import AdoptionTable from './AdoptionTable.svelte';
  import ChannelMoneyTable from './ChannelMoneyTable.svelte';
  import ChannelTrend from './ChannelTrend.svelte';
  import type { PageData } from './$types';

  let { data }: { data: PageData } = $props();

  const periodLabel = $derived(formatRange(data.range));
</script>

<header class="page-header flex flex-wrap items-start gap-3">
  <div>
    <h1>Monetization</h1>
    <p>How creators are monetizing their models, across the whole platform.</p>
  </div>
  <div class="ml-auto">
    <RangeSelector range={data.range} compare={data.compare} />
  </div>
</header>

<ChannelTrend daily={data.daily} comparison={data.comparison} compare={data.compare} />
<AdoptionTable adoption={data.adoption} />
<ChannelMoneyTable money={data.money} {periodLabel} />
