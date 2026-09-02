<script lang="ts">
  let { username }: { username?: string } = $props();
</script>

<header class="mb-6 flex items-center justify-between gap-3">
  <a href="/" class="flex items-center gap-2.5">
    <span
      class="grid h-7 w-7 place-items-center rounded-lg bg-gradient-to-br from-sky-700 to-sky-400 text-sm font-bold text-white"
    >
      C
    </span>
    <div class="font-semibold leading-tight text-white">
      Training Studio
      <span class="block font-mono text-[10px] uppercase tracking-widest text-dark-2">Beta</span>
    </div>
  </a>
  <span class="font-mono text-sm text-dark-2">
    {#if username}Signed in as <span class="text-dark-0">{username}</span>{/if}
  </span>
</header>
