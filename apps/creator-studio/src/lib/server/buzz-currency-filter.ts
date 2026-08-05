import type { Cookies } from '@sveltejs/kit';
import {
  BUZZ_CURRENCY_COOKIE,
  parseCurrencyFilter,
  type FilterableCurrency,
} from '$lib/buzz-currency-filter';

// Read server-side, not just in the browser, so SSR renders the filtered numbers directly instead of
// painting one total and rewriting it on hydration.
export function readBuzzCurrencyFilter(cookies: Cookies): FilterableCurrency[] {
  return parseCurrencyFilter(cookies.get(BUZZ_CURRENCY_COOKIE));
}
