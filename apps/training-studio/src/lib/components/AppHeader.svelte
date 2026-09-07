<script lang="ts">
  let { username, image }: { username?: string; image?: string } = $props();
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

  <div class="flex items-center gap-4">
    <a
      href="/"
      class="font-mono text-sm text-dark-2 transition-colors hover:text-white"
    >
      My trainings
    </a>
    {#if username}
      <div class="flex items-center gap-2" title={username}>
        {#if image}
          <img src={image} alt="" class="h-7 w-7 rounded-full object-cover" />
        {:else}
          <span
            class="grid h-7 w-7 place-items-center rounded-full bg-dark-5 text-xs font-semibold text-dark-0"
          >
            {username.slice(0, 1).toUpperCase()}
          </span>
        {/if}
        <span class="hidden font-mono text-sm text-dark-0 sm:inline">{username}</span>
      </div>
    {/if}
  </div>
</header>
