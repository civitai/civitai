import type { HandleClientError } from '@sveltejs/kit';

// hooks.server.ts only sees thrown loads/actions, so a page that server-renders fine and then dies on
// hydration leaves no trace anywhere — which is the exact shape of a "URL resolves but the page is
// blank" report. Ship those to the same Axiom stream so they can be read instead of reproduced.
export const handleError: HandleClientError = ({ error, event, status, message }) => {
  if (status === 404) return { message };

  try {
    const body = JSON.stringify({
      route: event.route?.id ?? null,
      // Full query string: whether the tab carried filters or ?mode= is usually the difference
      // between a report that reproduces and one that doesn't.
      url: event.url.pathname + event.url.search,
      status,
      message: String((error as Error)?.message ?? message).slice(0, 500),
      stack: String((error as Error)?.stack ?? '').slice(0, 4000),
    });
    // sendBeacon survives the teardown that usually follows a hydration failure; a fetch here often
    // never leaves the tab.
    navigator.sendBeacon?.('/api/client-error', new Blob([body], { type: 'application/json' }));
  } catch {
    // Reporting must never mask the error the user actually hit.
  }

  return { message };
};
