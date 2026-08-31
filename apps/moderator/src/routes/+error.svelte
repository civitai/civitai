<script lang="ts">
  import { page } from '$app/state';
</script>

<div class="grid min-h-[60vh] place-items-center text-center">
  <!-- `text-dark-2`, not a dimmer token: at `dark-4` this sat near 1.6:1 on the page background and a
       real 500 was reported as "a blank black screen". -->
  <div>
    <p class="text-6xl font-bold text-dark-2">{page.status}</p>
    <h1 class="mt-3 text-xl font-semibold text-white">
      {page.error?.message ?? 'Something went wrong'}
    </h1>
    <a href="/" class="mt-5 inline-block text-sm text-blue-4 hover:underline">← Back to dashboard</a>
  </div>
</div>
