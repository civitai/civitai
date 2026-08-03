import { page } from '$app/state';
import { goto } from '$app/navigation';

// URL-driven table sort + pagination. Uses goto (reliable page.url update + reactivity); the load re-run is a
// Redis cache hit since sort/page aren't part of the fetch's cache key. Sort replaces history; pagination pushes
// so Back walks pages.

function urlWith(mutate: (p: URLSearchParams) => void): string {
  const p = new URLSearchParams(page.url.searchParams);
  mutate(p);
  const qs = p.toString();
  return qs ? `${page.url.pathname}?${qs}` : page.url.pathname;
}

export function setSortParam(key: string, currentSort: string, currentDir: 'asc' | 'desc') {
  goto(
    urlWith((p) => {
      if (currentSort === key) p.set('dir', currentDir === 'desc' ? 'asc' : 'desc');
      else {
        p.set('sort', key);
        p.set('dir', 'desc');
      }
      p.delete('page'); // a new sort starts at page 1
    }),
    { keepFocus: true, noScroll: true, replaceState: true }
  );
}

export function setPageParam(n: number) {
  goto(
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
