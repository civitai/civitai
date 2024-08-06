<script lang="ts">
  let count = $state(0);
</script>

<div class="flex gap-2">
  <button onclick={() => count++}>+</button>
  <span>{count}</span>
  <button onclick={() => count--}>-</button>
</div>
