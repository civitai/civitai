import React, { createContext, useContext } from 'react';

// export function createSafeContext<ContextValue>(errorMessage: string) {
//   const Context = createContext<ContextValue | null>(null);

//   const useSafeContext = () => {
//     const ctx = useContext(Context);

//     if (ctx === null) {
//       throw new Error(errorMessage);
//     }

//     return ctx;
//   };

//   const Provider = ({ children, value }: { value: ContextValue; children: React.ReactNode }) => (
//     <Context.Provider value={value}>{children}</Context.Provider>
//   );

//   return [Provider, useSafeContext] as const;
// }

export function createContextAndProvider<ContextValue>(errorMessage?: string) {
  const Context = createContext<ContextValue | null>(null);

  function useProviderContext() {
    const ctx = useContext(Context);
    if (errorMessage && ctx === null) throw new Error(errorMessage);
    return ctx;
  }

  function Provider({ children, value }: { children: React.ReactNode; value: ContextValue }) {
    return <Context.Provider value={value}>{children}</Context.Provider>;
  }

  return [Provider, useProviderContext] as const;
}
