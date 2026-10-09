<script lang="ts">
  import { enhance } from '$app/forms';
  import { Button } from '@civitai/ui/components/ui/button/index.js';
  import { Input } from '@civitai/ui/components/ui/input/index.js';
  import { Label } from '@civitai/ui/components/ui/label/index.js';
  import { Textarea } from '@civitai/ui/components/ui/textarea/index.js';
  import type { SubmitFunction } from '@sveltejs/kit';

  type Rule = {
    id: number;
    subject: string;
    description: string;
    aliases: string[];
    note: string;
  };

  let { rule, onclose }: { rule: Rule | null; onclose: () => void } = $props();

  let busy = $state(false);

  const submit: SubmitFunction = () => {
    busy = true;
    return async ({ result, update }) => {
      try {
        await update({ reset: false });
        if (result.type === 'success') onclose();
      } finally {
        busy = false;
      }
    };
  };
</script>

<form
  method="POST"
  action="?/save"
  use:enhance={submit}
  class="mb-4 flex max-w-2xl flex-col gap-3 rounded-xl border border-dark-4 bg-dark-6 p-4"
>
  <h2 class="text-sm font-semibold text-white">
    {rule ? `Edit rule ${rule.id}` : 'New rule'}
  </h2>
  {#if rule}<input type="hidden" name="id" value={rule.id} />{/if}

  <div>
    <Label for="rule-subject" class="text-xs text-dark-2">Subject</Label>
    <Input id="rule-subject" name="subject" required maxlength={200} value={rule?.subject ?? ''} />
  </div>
  <div>
    <Label for="rule-description" class="text-xs text-dark-2">
      Description (what the scan should look for)
    </Label>
    <Textarea
      id="rule-description"
      name="description"
      rows={3}
      maxlength={2000}
      value={rule?.description ?? ''}
    />
  </div>
  <div>
    <Label for="rule-aliases" class="text-xs text-dark-2">
      Aliases (separate with commas or new lines)
    </Label>
    <Textarea id="rule-aliases" name="aliases" rows={3} value={rule?.aliases.join('\n') ?? ''} />
  </div>
  <div>
    <Label for="rule-note" class="text-xs text-dark-2">Internal note (not shown to the scan)</Label>
    <Textarea id="rule-note" name="note" rows={2} maxlength={2000} value={rule?.note ?? ''} />
  </div>

  <div class="flex justify-end gap-2">
    <Button type="button" variant="outline" disabled={busy} onclick={onclose}>Cancel</Button>
    <Button type="submit" disabled={busy}>Save</Button>
  </div>
</form>
