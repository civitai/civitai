<script lang="ts">
  import { page } from '$app/state';
</script>

<div class="grid min-h-[60vh] place-items-center text-center">
  <div>
    <p class="text-6xl font-bold text-dark-4">{page.status}</p>
    <h1 class="mt-3 text-xl font-semibold text-white">{page.error?.message ?? 'Something went wrong'}</h1>
    <a href="/" class="mt-5 inline-block text-sm text-blue-4 hover:underline">← Back to dashboard</a>
  </div>
</div>
