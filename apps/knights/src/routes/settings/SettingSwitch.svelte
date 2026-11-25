<script lang="ts">
  import { enhance } from '$app/forms';

  let {
    action,
    field,
    fields = {},
    on: stored,
    labelledby,
    describedby,
    onsaved,
    onerror,
  }: {
    action: string;
    /** The form field carrying `on` or `off`. */
    field: string;
    /** Other fields the action needs, sent as they are. */
    fields?: Record<string, string>;
    on: boolean;
    labelledby: string;
    describedby?: string;
    onsaved: (on: boolean) => void;
    onerror: (message: string) => void;
  } = $props();

  let saving = $state(false);
  // The switch flips at the click and flips back on a failure; the value the last save stored stays without a reload.
  let pending = $state<boolean | null>(null);
  let savedOn = $state<boolean | null>(null);
  const on = $derived(pending ?? savedOn ?? stored);
</script>

<form
  method="POST"
  {action}
  use:enhance={({ formData, cancel }) => {
    if (saving) return cancel();
    pending = formData.get(field) === 'on';
    saving = true;
    return async ({ result, update }) => {
      try {
        if (result.type === 'success') {
          savedOn = pending;
          onsaved(savedOn === true);
        } else if (result.type === 'failure') {
          onerror(String(result.data?.message ?? 'Your choice was not saved. Try again.'));
        } else if (result.type === 'error') {
          onerror('Your choice was not saved. Check your connection and try again.');
        } else {
          await update();
        }
      } catch {
        onerror('Your choice was not saved. Try again.');
      } finally {
        saving = false;
        pending = null;
      }
    };
  }}
>
  {#each Object.entries(fields) as [name, value] (name)}
    <input type="hidden" {name} {value} />
  {/each}
  <input type="hidden" name={field} value={on ? 'off' : 'on'} />
  <button
    type="submit"
    class="switch"
    role="switch"
    aria-checked={on}
    aria-labelledby={labelledby}
    aria-describedby={describedby}
    aria-disabled={saving}
  >
    <span class="knob"></span>
  </button>
</form>

<style>
  .switch {
    display: flex;
    flex: none;
    align-items: center;
    width: 2.75rem;
    min-width: 0;
    height: 1.5rem;
    min-height: 0;
    padding: 2px;
    border: 1px solid color-mix(in srgb, var(--io-gold-muted) 55%, transparent);
    border-radius: 999px;
    background: var(--io-matte);
    cursor: pointer;
  }

  .switch[aria-checked='true'] {
    justify-content: flex-end;
    border-color: var(--io-gold);
    background: var(--io-gold);
  }

  .switch:hover:not([aria-disabled='true']) {
    border-color: var(--io-gold);
    background: var(--io-matte);
  }

  .switch[aria-checked='true']:hover:not([aria-disabled='true']) {
    border-color: var(--io-parchment);
    background: var(--io-gold);
  }

  .switch[aria-disabled='true'] {
    cursor: progress;
    opacity: 0.6;
  }

  .switch:focus-visible {
    outline: 2px solid var(--io-gold);
    outline-offset: 2px;
  }

  .knob {
    width: 1.125rem;
    height: 1.125rem;
    border-radius: 50%;
    background: var(--io-parchment-muted);
  }

  .switch[aria-checked='true'] .knob {
    background: var(--io-bg);
  }
</style>
