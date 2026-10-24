<script lang="ts">
  import { Label } from '@civitai/ui/components/ui/label/index.js';
  import { Textarea } from '@civitai/ui/components/ui/textarea/index.js';
  import { cn } from '@civitai/ui/utils.js';
  import type { CannedReason } from '$lib/moderation-reasons';

  let {
    reasons,
    name = 'reason',
    rows = 2,
    idPrefix = 'reason',
    value = $bindable(''),
    flag = $bindable<CannedReason['flag']>(undefined),
  }: {
    reasons: CannedReason[];
    /** Form field the message is submitted under. */
    name?: string;
    rows?: number;
    /** Unique per mounted picker — two on one page would otherwise share label targets. */
    idPrefix?: string;
    value?: string;
    /** Set when the chosen reason implies an image flag; the caller decides what to do with it. */
    flag?: CannedReason['flag'];
  } = $props();

  let picked = $state<string | null>(null);

  // Retool's "Other" is the entry whose message is empty, not a separate mode — so choosing a canned
  // reason fills the box and leaves it editable rather than replacing it.
  const choose = (r: CannedReason) => {
    picked = r.label;
    value = r.message;
    flag = r.flag;
  };
</script>

<fieldset class="mb-2">
  <legend class="mb-1.5 text-xs tracking-wide text-dark-2 uppercase">Reason</legend>
  <div class="flex flex-wrap gap-1.5">
    {#each reasons as r (r.label)}
      <button
        type="button"
        onclick={() => choose(r)}
        aria-pressed={picked === r.label}
        class={cn(
          'rounded-md border px-2 py-1 text-xs',
          picked === r.label
            ? 'border-primary bg-primary/15 text-white'
            : 'border-dark-4 text-dark-2 hover:bg-dark-5 hover:text-dark-0'
        )}
      >
        {r.label}
      </button>
    {/each}
  </div>
</fieldset>

<Label for="{idPrefix}-message" class="sr-only">Message sent to the user</Label>
<Textarea
  id="{idPrefix}-message"
  {name}
  {rows}
  bind:value
  placeholder="Pick a reason above, or write one. This text is sent to the user."
  required
/>
