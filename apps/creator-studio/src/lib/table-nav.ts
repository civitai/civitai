import { page } from '$app/state';
import { goto } from '$app/navigation';

// URL-driven pagination. Uses goto (reliable page.url update + reactivity); the load re-run is a Redis cache
// hit since page isn't part of the fetch's cache key. Pushes history so Back walks pages. Sort is NOT here —
// it's a cookie the server reads (state/table-sort.svelte.ts).

function urlWith(mutate: (p: URLSearchParams) => void): string {
  const p = new URLSearchParams(page.url.searchParams);
  mutate(p);
  const qs = p.toString();
  return qs ? `${page.url.pathname}?${qs}` : page.url.pathname;
}

// Returns the navigation promise so a caller that also triggers a load (e.g. a cookie write) can sequence
// them — running both at once lets the goto supersede the invalidateAll, whose promise then never settles.
export function setPageParam(n: number) {
  return goto(
    urlWith((p) => {
      if (n <= 1) p.delete('page');
      else p.set('page', String(n));
    }),
    { keepFocus: true, noScroll: true }
  );
}

// Windowed page numbers for the pager: always the first + last page and a small window around the current one,
// with '…' gaps — e.g. 1 … 5 6 [7] 8 9 … 32. Keeps the control compact for creators with many pages.
export function pageWindow(current: number, total: number, window = 1): (number | '…')[] {
  const pages = new Set<number>([1, total]);
  for (let i = current - window; i <= current + window; i++) {
    if (i >= 1 && i <= total) pages.add(i);
  }
  const out: (number | '…')[] = [];
  let prev = 0;
  for (const p of [...pages].sort((a, b) => a - b)) {
    if (p - prev > 1) out.push('…');
    out.push(p);
    prev = p;
  }
  return out;
}
