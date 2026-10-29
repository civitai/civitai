<script lang="ts">
  import { browsingLevels, getBrowsingLevelLabel } from '@civitai/shared';
  import {
    ToggleGroup,
    ToggleGroupItem,
  } from '@civitai/ui/components/ui/toggle-group/index.js';

  let {
    name = 'level',
    value = $bindable<number | null>(null),
    onchange,
  }: { name?: string; value?: number | null; onchange?: (value: number | null) => void } = $props();
</script>

<input type="hidden" {name} value={value ?? ''} />
<ToggleGroup
  type="single"
  size="sm"
  variant="outline"
  value={value === null ? '' : String(value)}
  onValueChange={(v) => {
    value = v ? Number(v) : null;
    onchange?.(value);
  }}
>
  {#each browsingLevels as level (level)}
    <ToggleGroupItem value={String(level)}>{getBrowsingLevelLabel(level)}</ToggleGroupItem>
  {/each}
</ToggleGroup>
