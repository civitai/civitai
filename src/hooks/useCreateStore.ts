import { useState } from 'react';
import { createStore } from 'zustand';

export function useCreateStore<TStore extends Record<string, unknown>>(defaultValues: TStore) {
  const [store] = useState(() => createStore<TStore>(() => ({ ...defaultValues })));

  return store;
}
