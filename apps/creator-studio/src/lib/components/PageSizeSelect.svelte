<script lang="ts">
  import { NativeSelect, NativeSelectOption } from '@civitai/ui/components/ui/native-select/index.js';
  import { analyticsPageSize, PAGE_SIZE_OPTIONS } from '$lib/stores/analytics-page-size';
</script>

<label class="flex items-center gap-1.5 text-xs text-dark-3">
  Per page
  <NativeSelect
    aria-label="Rows per page"
    value={String(analyticsPageSize.value)}
    onchange={(e) => analyticsPageSize.set(Number(e.currentTarget.value))}
    class="h-7 py-0 text-xs [&>option]:bg-dark-7 [&>option]:text-white"
  >
    {#each PAGE_SIZE_OPTIONS as n (n)}
      <NativeSelectOption value={String(n)}>{n}</NativeSelectOption>
    {/each}
  </NativeSelect>
</label>
