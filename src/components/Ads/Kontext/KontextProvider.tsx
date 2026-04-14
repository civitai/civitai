import { createContext, useCallback, useContext, useMemo, useRef } from 'react';

type KontextMessage = {
  content: string;
  createdAt?: Date;
};

type Context = {
  getMessages: (index: number) => KontextMessage[];
};

const KontextContext = createContext<Context | null>(null);
export function useKontextContext() {
  const context = useContext(KontextContext);
  if (!context) throw new Error('missing KontextProvider');
  return context;
}

export function KontextProvider({
  children,
  messages,
  batchSize = 5,
}: {
  children: React.ReactNode;
  messages?: Partial<KontextMessage>[];
  batchSize?: number;
}) {
  const groups: KontextMessage[][] = useMemo(() => {
    if (!messages?.length || !messages.filter((x) => x.content).length) return [];
    const bucket: KontextMessage[][] = [];
    for (let i = 0; i < messages.length; ) {
      const upperIndex = i + 5;
      const groupMessages = messages.slice(i, upperIndex).filter((x) => x.content);
      if (!groupMessages.length) {
        groupMessages.push(...messages.filter((x) => x.content).slice(0, batchSize));
      }
      bucket.push(groupMessages as KontextMessage[]);
      i = upperIndex;
    }
    return bucket;
  }, [messages]);

  const getMessages = useCallback(
    (index: number) => groups[Math.floor(index / batchSize)],
    [groups]
  );
  const stateRef = useRef<Context | null>(null);
  stateRef.current = { getMessages };

  return <KontextContext.Provider value={stateRef.current}>{children}</KontextContext.Provider>;
}
