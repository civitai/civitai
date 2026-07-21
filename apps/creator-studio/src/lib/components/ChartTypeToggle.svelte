<script lang="ts">
  import { ToggleGroup, ToggleGroupItem } from '@civitai/ui/components/ui/toggle-group/index.js';
  import { chartType } from '$lib/stores/chart-type';
</script>

<ToggleGroup
  type="single"
  value={$chartType}
  onValueChange={(v: string) => {
    if (v) $chartType = v as 'line' | 'bar';
  }}
  variant="outline"
  size="sm"
>
  <ToggleGroupItem value="line" aria-label="Line chart" class="text-xs">Line</ToggleGroupItem>
  <ToggleGroupItem value="bar" aria-label="Bar chart" class="text-xs">Bar</ToggleGroupItem>
</ToggleGroup>
