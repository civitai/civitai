<script lang="ts">
  import { Button } from '@civitai/ui/components/ui/button/index.js';
  import { IconBolt, IconCheck } from '@tabler/icons-svelte';
  import { CREATOR_PROGRAM_CAPABILITIES } from '$lib/creator-program';

  // The perks unlocked by joining — the member-only capabilities (not the ones everyone already has).
  const unlocked = CREATOR_PROGRAM_CAPABILITIES.filter((c) => c.member && !c.everyone);
</script>

<header class="page-header">
  <h1>Welcome to the Creator Program 🎉</h1>
  <p>You're in — the Studio's monetization tools are now unlocked.</p>
</header>

<section class="mb-8 rounded-lg border border-green-9/50 bg-green-9/10 p-5">
  <div class="flex items-start gap-3">
    <IconBolt size={28} class="mt-0.5 shrink-0 text-green-4" />
    <div class="min-w-0">
      <p class="text-xs uppercase tracking-wide text-green-4">You've joined</p>
      <p class="mt-1 text-lg font-semibold text-white">Start earning from your models</p>
      <p class="mt-2 text-sm text-green-3">
        Set per-generation licensing fees, sell paid access, and track your earnings — all from the
        Studio.
      </p>
    </div>
  </div>
</section>

<section class="mb-8">
  <h2 class="mb-3 text-sm font-medium text-white">What you can do now</h2>
  <ul class="flex flex-col gap-2">
    {#each unlocked as cap (cap.label)}
      <li class="flex items-center gap-2 text-sm text-dark-1">
        <IconCheck size={16} class="shrink-0 text-green-5" />
        {cap.label}
      </li>
    {/each}
  </ul>
</section>

<div class="flex flex-wrap gap-3">
  <Button href="/models">Manage your models</Button>
  <Button href="/earnings" variant="outline">View earnings</Button>
  <Button href="/dashboard" variant="outline">Go to dashboard</Button>
</div>
