<script lang="ts">
  import type { PageData } from './$types';
  import AccountView from './AccountView.svelte';
  import { reportActionGrants } from '$lib/report-queue';

  let { data }: { data: PageData } = $props();
</script>

<AccountView
  account={data.account}
  items={data.items}
  canAct={data.canAct}
  canBan={data.canBan}
  canInvestigate={data.canInvestigate}
  can={reportActionGrants(data.grants)}
  civitaiUrl={data.civitaiUrl}
/>
