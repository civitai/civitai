import React, { createContext, useContext, useState, useRef, useEffect } from 'react';
import { isProd } from '~/env/other';

const AscendeumAdsContext = createContext<{ ready: boolean }>({ ready: false });
export function useAscendeumAdsContext() {
  return useContext(AscendeumAdsContext);
}
export function AscendeumAdsProvider({ children }: { children: React.ReactNode }) {
  const [ready, setReady] = useState(false);

  const readyRef = useRef(false);
  useEffect(() => {
    if (!readyRef.current && isProd) {
      readyRef.current = true;
      const script = document.createElement('script');
      script.type = 'text/javascript';
      script.src = 'https://ascendeum.hbwrapper.com/asc.example.js';
      script.onload = () => {
        setReady(true);
      };
      document.body.appendChild(script);
    }
  }, []);

  return <AscendeumAdsContext.Provider value={{ ready }}>{children}</AscendeumAdsContext.Provider>;
}
