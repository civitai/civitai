// The terminal "we couldn't sign you in" page shown when a login redirect loop is broken. Two entry points reach
// a genuine loop from opposite sides — /api/auth/authorize (civ-token cookie ABSENT) and /api/auth/post-login
// (cookie PRESENT but not verifiable) — so the page lives here, shared, instead of being copy-pasted in each.
export function renderSignInProblemHtml(): string {
  return (
    `<!doctype html><html><head><meta charset="utf-8"><title>Sign-in problem</title>` +
    `<meta name="viewport" content="width=device-width,initial-scale=1">` +
    `<style>body{background:#0b0c10;color:#e8eaed;font-family:system-ui,sans-serif;display:grid;` +
    `place-items:center;height:100vh;margin:0}.card{max-width:420px;padding:1.5rem;text-align:center}` +
    `h1{font-size:1.2rem;margin:0 0 .5rem}p{color:#9aa0a6;font-size:.9rem;line-height:1.5}a{color:#4285f4}` +
    `</style></head><body><div class="card"><h1>We couldn't sign you in</h1><p>Your session couldn't be ` +
    `established — this is usually a temporary cookie issue. We've cleared it; please ` +
    `<a href="/">return home</a> and try signing in again.</p></div></body></html>`
  );
}
