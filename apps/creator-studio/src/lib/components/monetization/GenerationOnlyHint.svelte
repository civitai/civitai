<script lang="ts">
  // Link form of GENERATION_ONLY_HINT — keep the wording in sync. The constant stays plain text: it is
  // also a 403 body and a `title` attribute.
  import { CIVITAI_MEMBERSHIP_URL } from '$lib/creator-program';

  let { class: className = '' }: { class?: string } = $props();
</script>

<p class={`text-xs text-dark-2 ${className}`}>
  On-site-generation-only resources require a
  <a href={CIVITAI_MEMBERSHIP_URL} target="_blank" rel="noreferrer" class="underline"
    >Gold membership</a
  >.
</p>
