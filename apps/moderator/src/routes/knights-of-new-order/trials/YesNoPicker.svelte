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
  bind:value={
    () => value ?? '',
    (v) => {
      // Clicking the selected item clears the group; the getter hands the answer back so it stays shown.
      if (v === 'yes' || v === 'no') onchange(v);
    }
  }
>
  <ToggleGroupItem value="yes">Yes</ToggleGroupItem>
  <ToggleGroupItem value="no">No</ToggleGroupItem>
</ToggleGroup>
