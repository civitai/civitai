import { CookieState } from '$lib/state/cookie-state.svelte';
import {
  BUZZ_CURRENCY_COOKIE,
  FILTERABLE_CURRENCIES,
  encodeCurrencyFilter,
  type FilterableCurrency,
} from '$lib/buzz-currency-filter';

/**
 * Which buzz types the earnings columns count, backed by the shared cookie so SSR renders filtered numbers.
 *
 * Shared by /analytics/models and a model's version page — one choice, both tables.
 */
export function buzzCurrencyState(canonical: () => FilterableCurrency[]) {
  const state = new CookieState<FilterableCurrency[]>(BUZZ_CURRENCY_COOKIE, canonical, {
    encode: encodeCurrencyFilter,
  });

  return {
    get value() {
      return state.value;
    },
    // ToggleGroup hands back the whole selection; ordering it by FILTERABLE_CURRENCIES keeps the cookie
    // stable regardless of the order the chips were clicked in.
    set(next: string[]) {
      return state.set(FILTERABLE_CURRENCIES.filter((c) => next.includes(c)));
    },
  };
}
