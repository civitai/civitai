import { useState, useEffect } from 'react';
import type { DatesProviderSettings } from '@mantine/dates';

type DateLocaleResult = Pick<DatesProviderSettings, 'locale' | 'timezone' | 'firstDayOfWeek'>;

export function useDateLocale(): DateLocaleResult {
  const [result, setResult] = useState<DateLocaleResult>({
    locale: 'en',
    timezone: undefined,
    firstDayOfWeek: undefined,
  });

  useEffect(() => {
    const browserLocale = navigator.language?.toLowerCase() ?? 'en';
    const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone;

    // 'en' is built-in to dayjs, no import needed
    if (browserLocale === 'en' || browserLocale === 'en-us') {
      setResult({ locale: 'en', timezone, firstDayOfWeek: 0 });
      return;
    }

    const loadLocale = async () => {
      const tag = browserLocale; // e.g. "pt-br", "de", "fr"
      const lang = tag.split('-')[0]; // e.g. "pt", "de", "fr"

      let localeData: { default?: { weekStart?: number } } | undefined;
      let resolvedLocale = 'en';

      try {
        // Try full tag first (e.g. "pt-br", "zh-cn")
        localeData = await import(`dayjs/locale/${tag}.js`);
        resolvedLocale = tag;
      } catch {
        try {
          // Fall back to language-only (e.g. "pt", "zh")
          localeData = await import(`dayjs/locale/${lang}.js`);
          resolvedLocale = lang;
        } catch {
          // Unsupported locale, keep 'en' default
        }
      }

      const weekStart = localeData?.default?.weekStart;
      const firstDayOfWeek =
        weekStart !== undefined && weekStart >= 0 && weekStart <= 6
          ? (weekStart as DatesProviderSettings['firstDayOfWeek'])
          : undefined;

      setResult({ locale: resolvedLocale, timezone, firstDayOfWeek });
    };

    loadLocale();
  }, []);

  return result;
}
