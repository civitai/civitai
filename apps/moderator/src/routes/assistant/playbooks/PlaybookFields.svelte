<script lang="ts">
  import { Input } from '@civitai/ui/components/ui/input/index.js';
  import { Label } from '@civitai/ui/components/ui/label/index.js';
  import { Textarea } from '@civitai/ui/components/ui/textarea/index.js';

  // The fields of one playbook version, shared by the new-playbook form and the edit form.
  let {
    title = '',
    summary = '',
    body = '',
    disabled = false,
  }: { title?: string; summary?: string; body?: string; disabled?: boolean } = $props();
</script>

<div class="space-y-3">
  <div>
    <Label for="pb-title" class="text-xs text-dark-2">Title</Label>
    <Input id="pb-title" name="title" value={title} maxlength={120} required {disabled} />
  </div>
  <div>
    <Label for="pb-summary" class="text-xs text-dark-2">When to use it (one sentence the assistant sees)</Label>
    <Input id="pb-summary" name="summary" value={summary} maxlength={300} required {disabled} />
  </div>
  <div>
    <Label for="pb-body" class="text-xs text-dark-2">Steps</Label>
    <Textarea id="pb-body" name="body" value={body} rows={14} maxlength={8000} required {disabled} class="font-mono text-xs" />
  </div>
  <div>
    <Label for="pb-note" class="text-xs text-dark-2">What changed (optional)</Label>
    <Input id="pb-note" name="note" maxlength={500} {disabled} />
  </div>
</div>
