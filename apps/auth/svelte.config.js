import adapter from '@sveltejs/adapter-node';
import { vitePreprocess } from '@sveltejs/vite-plugin-svelte';

/** @type {import('@sveltejs/kit').Config} */
const config = {
  preprocess: vitePreprocess(),
  kit: {
    adapter: adapter(),
    // Disable SvelteKit's built-in form-CSRF origin check (prod-only). The OAuth machine endpoints
    // (token / revoke / device / device-token) are `application/x-www-form-urlencoded` per spec and are
    // called cross-origin or server-to-server (no Origin header), which SvelteKit's check 403s with a
    // plain-text "Cross-site POST form submissions are forbidden" — breaking third-party token exchange.
    // It can't be scoped per-route (it runs before the handle hook) and trustedOrigins can't cover the
    // no-Origin server-to-server case. These endpoints have their own protection (client_secret/PKCE,
    // per-client allowedOrigins, CORS); the session cookie is SameSite=Lax for the form actions.
    csrf: { checkOrigin: false },
  },
};

export default config;
