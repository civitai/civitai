const escapeHtml = (text: string) =>
  text.replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!)
  );

const SHIELD =
  '<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M20 13c0 5-3.5 7.5-7.66 8.95a1 1 0 0 1-.67-.01C7.5 20.5 4 18 4 13V6a1 1 0 0 1 1-1c2 0 4.5-1.2 6.24-2.72a1.17 1.17 0 0 1 1.52 0C14.51 3.81 17 5 19 5a1 1 0 0 1 1 1z"/></svg>';
const DOOR =
  '<svg width="30" height="30" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M18 20V6a2 2 0 0 0-2-2H8a2 2 0 0 0-2 2v14"/><path d="M2 20h20"/><path d="M14 12v.01"/></svg>';

/**
 * The page a signed-in user without access sees (403). Self-contained: it renders before the app's layout and
 * stylesheet exist, so it carries its own styles and loads the same fonts as `app.html`.
 */
export function closedPageHtml({
  username,
  civitaiUrl,
  reason = 'closed',
}: {
  username?: string;
  civitaiUrl: string;
  /** `closed`: the app is not open to this user yet. `banned`: this account cannot enter. */
  reason?: 'closed' | 'banned';
}) {
  const name = username ? escapeHtml(username) : '';
  const home = escapeHtml(civitaiUrl);
  return `<!doctype html><html lang="en"><head><meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<meta name="robots" content="noindex" />
<title>Knights of New Order</title>
<link rel="preconnect" href="https://fonts.googleapis.com" />
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Cinzel:wght@600;700&family=EB+Garamond:wght@400;500&family=Inter:wght@400;500;600;700&display=swap" />
<style>
  :root { color-scheme: dark; --gold: #c9a24a; --parchment: #e8dcc0; --muted: #a89c80; }
  * { box-sizing: border-box; }
  body { margin: 0; min-height: 100vh; display: flex; flex-direction: column; color: var(--parchment);
    background: radial-gradient(ellipse 60% 55% at 50% 42%, #33250f 0%, #14110d 70%);
    font: 18px/1.6 'EB Garamond', Georgia, serif; }
  header { display: flex; align-items: center; justify-content: space-between; gap: 1rem; padding: 1.25rem 2rem; }
  .brand { display: flex; align-items: center; gap: .6rem; color: var(--gold); text-decoration: none;
    font: 700 1rem/1 'Cinzel', Georgia, serif; letter-spacing: .14em; text-transform: uppercase; }
  .who { display: flex; align-items: center; gap: 1.25rem; font: 400 .95rem/1 'Inter', system-ui, sans-serif; color: var(--muted); }
  .who strong { color: var(--parchment); font-weight: 600; }
  .who a { color: var(--muted); text-decoration: none; }
  .who a:hover { color: var(--parchment); }
  main { flex: 1; display: flex; flex-direction: column; align-items: center; justify-content: center;
    padding: 2rem 1.5rem 5rem; text-align: center; }
  .seal { display: inline-flex; align-items: center; justify-content: center; width: 70px; height: 70px;
    border: 1.5px solid var(--gold); border-radius: 50%; background: #1f1a13; color: var(--gold); }
  .kicker { margin: .6rem 0 1.5rem; color: var(--parchment); font: 700 1rem/1 'Cinzel', Georgia, serif;
    letter-spacing: .14em; text-transform: uppercase; }
  h1 { margin: 0; max-width: 40rem; color: var(--parchment); font: 700 clamp(1.7rem, 5vw, 2.75rem)/1.15 'Cinzel', Georgia, serif;
    letter-spacing: .04em; text-transform: uppercase; }
  .rule { display: flex; align-items: center; gap: 1rem; width: min(22rem, 80%); margin: 1.5rem 0; color: var(--gold); }
  .rule::before, .rule::after { content: ''; flex: 1; height: 1px; background: #6f5b2f; }
  .rule i { width: 8px; height: 8px; border: 1px solid currentColor; transform: rotate(45deg); }
  p { margin: 0; max-width: 32rem; color: var(--muted); font-size: 1.3rem; line-height: 1.5; }
  .actions { display: flex; flex-wrap: wrap; justify-content: center; gap: 1rem; margin-top: 1.75rem; }
  .btn { display: inline-flex; align-items: center; justify-content: center; min-height: 2.75rem; padding: .65rem 1.7rem;
    border: 1.5px solid var(--gold); border-radius: 4px; color: var(--gold); text-decoration: none;
    font: 700 .95rem/1.2 'Cinzel', Georgia, serif; letter-spacing: .14em; text-transform: uppercase; }
  .btn.primary { background: var(--gold); color: #14110d; }
  :focus-visible { outline: 2px solid var(--gold); outline-offset: 2px; }
  @media (max-width: 40rem) { header { padding: 1rem; } .who a { display: none; } .brand span { font-size: .9rem; }
    .actions { flex-direction: column; align-self: stretch; } }
</style></head>
<body>
<header>
  <a class="brand" href="${home}">${SHIELD}<span>Knights of New Order</span></a>
  ${
    name
      ? `<div class="who"><strong>${name}</strong><a href="${home}">Back to Civitai</a><a href="/logout">Sign out</a></div>`
      : ''
  }
</header>
<main>
  <span class="seal">${DOOR}</span>
  <p class="kicker">The Gates</p>
  <h1>${reason === 'banned' ? 'The gates are closed to you' : 'The gates are not yet open'}</h1>
  <div class="rule" aria-hidden="true"><i></i></div>
  <p>${
    reason === 'banned'
      ? "Your account can't enter the Order."
      : 'The Knights of New Order is not open to everyone yet. There is nothing you need to do. Return when the gates open.'
  }</p>
  <div class="actions">
    <a class="btn primary" href="${home}">Back to Civitai</a>
    <a class="btn" href="/logout">Sign out</a>
  </div>
</main>
</body></html>`;
}
