<script lang="ts">
  import { LINK_CLASS } from '$lib/format';
  import type { ResolvedHandOff } from '$lib/automated-text/hand-off';

  let { handOff, locked = false }: { handOff: ResolvedHandOff; locked?: boolean } = $props();

  const linkClass = $derived(`${LINK_CLASS} ${locked ? 'pointer-events-none opacity-50' : ''}`);
</script>

<div class="flex flex-wrap items-center gap-x-4 gap-y-1">
  {#each handOff.links as link (link.href)}
    <a
      href={link.href}
      class={linkClass}
      aria-disabled={locked || undefined}
      tabindex={locked ? -1 : undefined}
      target={link.external ? '_blank' : undefined}
      rel={link.external ? 'noopener noreferrer' : undefined}>{link.label}</a
    >
  {/each}
</div>
{#if handOff.contentGone}
  <p class="mt-1 text-xs text-dark-2">
    The reported content has been deleted, so no report page can show report #{handOff.reportId}.
    Act on the author, or pass the report id to a moderator who can.
  </p>
{/if}
{#if handOff.blocked.length}
  <p class="mt-1 text-xs text-dark-2">
    You do not have access to: {handOff.blocked.join(', ')}. Pass report #{handOff.reportId} to a
    moderator who can open them.
  </p>
{/if}
