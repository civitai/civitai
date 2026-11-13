<script lang="ts">
  import { untrack } from 'svelte';
  import { enhance } from '$app/forms';
  import { Button } from '@civitai/ui/components/ui/button/index.js';
  import { Input } from '@civitai/ui/components/ui/input/index.js';
  import { Label } from '@civitai/ui/components/ui/label/index.js';
  import * as Select from '@civitai/ui/components/ui/select/index.js';
  import { Textarea } from '@civitai/ui/components/ui/textarea/index.js';
  import type { FormState } from '$lib/form-state.svelte';
  import {
    PLATFORM_FIXED_IN_COMPONENTS,
    PLATFORM_FIXED_IN_VERSION_MAX_LENGTH,
    PLATFORM_PUBLIC_NOTE_MAX_LENGTH,
    PLATFORM_REGRESSION_COMPONENTS,
    type PlatformResolution,
  } from '$lib/feedback-platform';
  import type { FeedbackRow } from '$lib/server/feedback.service';

  /**
   * Posts through the triage `FormState`, so the panel's one refusal banner covers it.
   *
   * 🔴 THE BOXES ARE SEEDED ONCE, AND `FeedbackDetail` REMOUNTS THIS WHEN THE STORED RESOLUTION
   * CHANGES. A refused save or an unrelated reload keeps what was typed; a save or a clear, by
   * anyone, shows what is stored. Seeded one-way instead, a version typed and then cleared stayed in
   * its box, because the stored value was blank before and after.
   */
  let {
    row,
    resolution,
    form,
  }: {
    row: Pick<FeedbackRow, 'id' | 'status'>;
    resolution: PlatformResolution | null;
    form: FormState;
  } = $props();

  let component = $state(untrack(() => resolution?.fixedIn?.component ?? ''));
  let version = $state(untrack(() => resolution?.fixedIn?.version ?? ''));
  let note = $state(untrack(() => resolution?.publicNote ?? ''));

  const NOTHING_SHIPPED = '— nothing shipped —';
  const regressionComponents = PLATFORM_REGRESSION_COMPONENTS.join(' and ');
</script>

<div class="flex min-w-0 flex-col gap-3 rounded-lg border border-dark-4 p-3">
  <h4 class="text-xs tracking-wide text-dark-2 uppercase">Resolution shown on status readback</h4>

  <form method="POST" action="?/triage" use:enhance={form.enhance} class="flex min-w-0 flex-col gap-3">
    <input type="hidden" name="id" value={row.id} />
    <input type="hidden" name="expectedStatus" value={row.status} />
    <input type="hidden" name="resolution" value="set" />
    <input type="hidden" name="expectedResolutionAt" value={resolution?.at ?? ''} />
    <input type="hidden" name="fixedInComponent" value={component} />

    <div class="grid gap-3 sm:grid-cols-2">
      <div class="flex flex-col gap-1">
        <Label for={`fixed-in-${row.id}`} class="text-xs text-dark-2">Fixed in</Label>
        <Select.Root type="single" bind:value={component}>
          <Select.Trigger id={`fixed-in-${row.id}`} class="w-full">
            {component || NOTHING_SHIPPED}
          </Select.Trigger>
          <Select.Content>
            <Select.Item value="">{NOTHING_SHIPPED}</Select.Item>
            {#each PLATFORM_FIXED_IN_COMPONENTS as option (option)}
              <Select.Item value={option}>{option}</Select.Item>
            {/each}
          </Select.Content>
        </Select.Root>
      </div>
      <div class="flex flex-col gap-1">
        <Label for={`fixed-in-version-${row.id}`} class="text-xs text-dark-2">
          Version (optional)
        </Label>
        <Input
          id={`fixed-in-version-${row.id}`}
          name="fixedInVersion"
          bind:value={version}
          placeholder="2.4.0"
          maxlength={PLATFORM_FIXED_IN_VERSION_MAX_LENGTH}
        />
      </div>
    </div>
    <p class="text-xs text-dark-2">
      Only {regressionComponents} versions are compared with a reporter's own client version: once the
      report is <em>actioned</em>, anyone on that version or later who reports it again opens a
      regression. An actioned report with a version reads back as <em>fixed</em>; without one, as
      <em>addressed</em>. For an <em>mcp</em> fix, leave Version blank: the hosted MCP server is one
      continuously deployed instance whose reported version does not change with each fix.
    </p>

    <div class="flex flex-col gap-1">
      <Label for={`public-note-${row.id}`} class="text-xs text-dark-2">Public note</Label>
      <Textarea
        id={`public-note-${row.id}`}
        name="publicNote"
        rows={2}
        maxlength={PLATFORM_PUBLIC_NOTE_MAX_LENGTH}
        bind:value={note}
      />
      <p class="text-xs text-dark-2">
        Shown word for word to anyone who reports this failure site or holds its reference — not
        only the original reporters. Up to {PLATFORM_PUBLIC_NOTE_MAX_LENGTH} characters; write
        nothing private here.
      </p>
    </div>

    <div class="flex flex-wrap gap-2">
      <!-- Same status: a resolution-only save; status and handled-by stay put. -->
      <Button type="submit" name="status" value={row.status} size="sm" disabled={form.submitting}>
        Save resolution
      </Button>
      {#if row.status !== 'actioned'}
        <Button
          type="submit"
          name="status"
          value="actioned"
          size="sm"
          variant="outline"
          disabled={form.submitting}
        >
          Save and mark actioned
        </Button>
      {/if}
    </div>
  </form>

  {#if resolution}
    <form method="POST" action="?/triage" use:enhance={form.enhance}>
      <input type="hidden" name="id" value={row.id} />
      <input type="hidden" name="expectedStatus" value={row.status} />
      <input type="hidden" name="status" value={row.status} />
      <input type="hidden" name="resolution" value="clear" />
      <input type="hidden" name="expectedResolutionAt" value={resolution?.at ?? ''} />
      <Button type="submit" size="sm" variant="ghost" disabled={form.submitting}>
        Clear resolution
      </Button>
    </form>
  {/if}
</div>
