import { DatesProvider } from '@mantine/dates';
import { useDateLocale } from '~/hooks/useDateLocale';

export function DateLocaleProvider({ children }: { children: React.ReactNode }) {
  const { locale, timezone, firstDayOfWeek } = useDateLocale();

  return (
    <DatesProvider settings={{ locale, timezone, firstDayOfWeek, weekendDays: [0, 6] }}>
      {children}
    </DatesProvider>
  );
}
