/** A JSON GET that rejects on a non-2xx status, so an `{#await}` lands in `{:catch}` with the status
 *  rather than rendering an error body as data. */
export const fetchJson = <T>(url: string): Promise<T> =>
  fetch(url).then((r) => {
    if (!r.ok) throw new Error(`Request failed (${r.status})`);
    return r.json() as Promise<T>;
  });
