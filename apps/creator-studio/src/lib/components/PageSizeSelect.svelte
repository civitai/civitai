<script lang="ts">
  import * as Select from '@civitai/ui/components/ui/select/index.js';
  import { analyticsPageSize, PAGE_SIZE_OPTIONS } from '$lib/stores/analytics-page-size';
</script>

<label class="flex items-center gap-1.5 text-xs text-dark-3">
  Per page
  <Select.Root
    type="single"
    value={String(analyticsPageSize.value)}
    onValueChange={(v: string) => {
      if (v) analyticsPageSize.set(Number(v));
    }}
  >
    <Select.Trigger size="sm" class="w-16 text-white" aria-label="Rows per page">
      {analyticsPageSize.value}
    </Select.Trigger>
    <Select.Content>
      {#each PAGE_SIZE_OPTIONS as n (n)}
        <Select.Item value={String(n)} label={String(n)} />
      {/each}
    </Select.Content>
  </Select.Root>
</label>
