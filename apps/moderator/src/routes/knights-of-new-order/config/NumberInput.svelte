<script lang="ts">
  import * as InputGroup from '@civitai/ui/components/ui/input-group/index.js';

  let {
    id,
    unit,
    value,
    placeholder = 'Default',
    invalid = false,
    oninput,
  }: {
    id: string;
    unit: string;
    value: string;
    placeholder?: string;
    invalid?: boolean;
    oninput: (value: string) => void;
  } = $props();
</script>

<InputGroup.Root class="w-40">
  <InputGroup.Input
    {id}
    type="text"
    inputmode="decimal"
    autocomplete="off"
    {placeholder}
    {value}
    aria-labelledby="{id}-label"
    aria-invalid={invalid}
    aria-describedby={invalid ? `${id}-error` : undefined}
    oninput={(event) => oninput(event.currentTarget.value)}
  />
  <InputGroup.Addon align="inline-end">
    <InputGroup.Text>{unit}</InputGroup.Text>
  </InputGroup.Addon>
</InputGroup.Root>
