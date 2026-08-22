<script lang="ts">
  import { CIVITAI_MEMBERSHIP_URL } from '$lib/creator-program';

  // The rendered form of GENERATION_ONLY_HINT. The constant stays plain text because it doubles as the
  // server's 403 message and as a `title` attribute, neither of which can carry a link.
  let { class: className = '' }: { class?: string } = $props();
</script>

<p class={`text-xs text-dark-2 ${className}`}>
  On-site-generation-only resources require a
  <a href={CIVITAI_MEMBERSHIP_URL} target="_blank" rel="noreferrer" class="underline"
    >Gold membership</a
  >.
</p>
