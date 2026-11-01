import { useLocalStorage, useMounted } from '@mantine/hooks';
import type { CompensationSource } from '~/server/schema/buzz.schema';

export const EARNINGS_SOURCE_STORAGE_KEY = 'buzz-dashboard-earnings-source';

export function useEarningsSource() {
  // Read in an effect so the server render and the first client render agree.
  const [stored, setSource] = useLocalStorage<CompensationSource>({
    key: EARNINGS_SOURCE_STORAGE_KEY,
    defaultValue: 'compensation',
    getInitialValueInEffect: true,
  });
  // Lands in the same commit as the stored value, so gating a query on it avoids fetching the
  // default source only to discard it.
  const ready = useMounted();
  // The value goes straight into a tRPC enum input; anything else in storage would fail validation.
  const source: CompensationSource =
    stored === 'licenseFee' || stored === 'tip' ? stored : 'compensation';

  return { source, setSource, ready };
}
