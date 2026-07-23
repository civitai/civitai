<script lang="ts">
  import { buzzNumber } from '$lib/earnings';

  // A buzz amount rendered with the ⚡ tucked against the number like a currency symbol. The icon is sized in `em`
  // so it scales with whatever font-size the surrounding element sets — reusable in a headline or a table cell.
  let { amount }: { amount: number } = $props();
</script>

<span class="whitespace-nowrap"><span class="mr-0.5 text-[0.82em]">⚡</span>{buzzNumber(amount)}</span>
