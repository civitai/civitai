import { carriedSearchParams } from './filters';

/**
 * A search box that searches as you type: a pause of `delay` ms submits, Enter submits at once. A
 * value equal to what the page already shows is never sent, and nothing is sent mid IME composition
 * (the half-composed text is not what the moderator means, and Enter there confirms the composition).
 */
export function searchDebouncer({
  delay,
  current,
  submit,
}: {
  delay: number;
  /** The search the page is showing now. */
  current: () => string;
  submit: (value: string) => void;
}) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let composing = false;

  const cancel = () => {
    clearTimeout(timer);
    timer = undefined;
  };
  const send = (value: string) => {
    cancel();
    // Compared with the page, not with the last send: a search whose navigation was cancelled must
    // still go when asked again.
    const next = value.trim();
    if (next !== current().trim()) submit(next);
  };
  const schedule = (value: string) => {
    cancel();
    timer = setTimeout(() => send(value), delay);
  };

  return {
    input(value: string) {
      if (!composing) schedule(value);
    },
    enter(value: string) {
      if (!composing) send(value);
    },
    compositionStart() {
      composing = true;
      cancel();
    },
    compositionEnd(value: string) {
      composing = false;
      schedule(value);
    },
    cancel,
    /** A typed search is waiting (or being composed): the box holds input the page doesn't show yet. */
    pending: () => composing || timer !== undefined,
  };
}

/** Where a search lands: the tab's filters and sort carried, the page, open item and old search not. */
export function searchHref(url: URL, value: string): string {
  const params = new URLSearchParams(carriedSearchParams(url.searchParams));
  const q = value.trim();
  if (q) params.set('q', q);
  const search = params.toString();
  return search ? `${url.pathname}?${search}` : url.pathname;
}
