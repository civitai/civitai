<script lang="ts">
  import {
    ToggleGroup,
    ToggleGroupItem,
  } from '@civitai/ui/components/ui/toggle-group/index.js';

  type Answer = 'yes' | 'no';

  let {
    name = 'answer',
    value,
    onchange,
  }: { name?: string; value: Answer | null; onchange: (value: Answer) => void } = $props();
</script>

<input type="hidden" {name} value={value ?? ''} />
<ToggleGroup
  type="single"
  size="sm"
  variant="outline"
  value={value ?? ''}
  onValueChange={(v) => {
    // Clicking the selected item clears the group; the answer is never unset.
    if (v === 'yes' || v === 'no') onchange(v);
  }}
>
  <ToggleGroupItem value="yes">Yes</ToggleGroupItem>
  <ToggleGroupItem value="no">No</ToggleGroupItem>
</ToggleGroup>
