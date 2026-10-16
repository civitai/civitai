<script lang="ts">
  import type { PageData } from './$types';
  import AccountView from './AccountView.svelte';

  let { data }: { data: PageData } = $props();
</script>

<AccountView
  account={data.account}
  items={data.items}
  canAct={data.canAct}
  canBan={data.canBan}
  civitaiUrl={data.civitaiUrl}
/>
