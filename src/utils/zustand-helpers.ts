import { useEffect, useState } from 'react';

export const usePersistentStore = <T, F>(
  store: (callback: (state: T) => unknown) => unknown,
  callback: (state: T) => F,
  defaultValue?: F
) => {
  const result = store(callback) as F;
  const [data, setData] = useState<F | undefined>();

  useEffect(() => {
    setData(result);
  }, [result]);

  return data ?? defaultValue;
};
