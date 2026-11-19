/**
 * Asks civitai to commit the open app, as its sandbox holds it now, to the app's source repo (the
 * developer's git history; `POST /api/apps/assistant/source-save`). The page's half of the
 * source-save scheduler (`createSourceSaveScheduler` in `@civitai/app-assistant`): the server reads
 * the app's files itself, as the signed-in user, so nothing but the app's key is sent.
 *
 * Never throws: a save that does not happen is carried by the next one (each commits the whole app).
 */
export const SOURCE_SAVE_ROUTE = '/api/apps/assistant/source-save';

export async function saveAppSource(app: string, fetchImpl: typeof fetch = fetch): Promise<void> {
  try {
    await fetchImpl(SOURCE_SAVE_ROUTE, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ app }),
      credentials: 'same-origin',
      // A save the reply's last change scheduled still goes when the page is left.
      keepalive: true,
    });
  } catch {
    // Offline, or the page is going away: the next save carries this change.
  }
}
