<script lang="ts">
  import { onMount } from 'svelte';
  import { IconAlertTriangle, IconX } from '@tabler/icons-svelte';
  import { browser } from '$lib/host';
  import { messageSegments } from '$lib/service-status-core';
  import { serviceStatus } from '$lib/service-status.svelte';

  // The classic trainer's TrainStatusMessage: training off → a fixed warning; on with a moderator
  // notice → a "Status Alert" the user can dismiss until the message changes.
  const DISMISSED_KEY = 'training-studio:dismissed-status';

  onMount(() => void serviceStatus.refresh());

  const status = $derived(serviceStatus.value);
  const disabled = $derived(status?.available === false);
  const message = $derived(
    disabled ? (status?.message ?? 'Training is currently disabled.') : (status?.message ?? null)
  );

  let dismissed = $state(browser ? localStorage.getItem(DISMISSED_KEY) : null);
  const visible = $derived(!!message && (disabled || dismissed !== message));

  function dismiss() {
    if (!message) return;
    dismissed = message;
    localStorage.setItem(DISMISSED_KEY, message);
  }
</script>

{#if visible && message}
  <div
    role="alert"
    class="flex items-start gap-3 rounded-lg border border-amber-500/30 bg-amber-500/10 px-4 py-3 text-sm text-dark-0"
  >
    <IconAlertTriangle size={18} stroke={2} class="mt-px shrink-0 text-amber-400" />
    <div class="min-w-0 flex-1">
      {#if !disabled}<p class="font-semibold text-amber-400">Status Alert</p>{/if}
      <p class="leading-snug">
        {#each messageSegments(message) as segment, i (i)}
          {#if segment.kind === 'strong'}<strong>{segment.text}</strong
            >{:else if segment.kind === 'link'}<a
              href={segment.href}
              target="_blank"
              rel="noreferrer"
              class="text-primary hover:underline">{segment.text}</a
            >{:else}{segment.text}{/if}
        {/each}
      </p>
    </div>
    {#if !disabled}
      <button
        type="button"
        onclick={dismiss}
        aria-label="Dismiss"
        class="shrink-0 text-dark-2 transition hover:text-dark-0"
      >
        <IconX size={16} stroke={2} />
      </button>
    {/if}
  </div>
{/if}
