import CacheableLookup from 'cacheable-lookup';
import http from 'http';
import https from 'https';
import { Agent, setGlobalDispatcher } from 'undici';

export function cacheDnsEntries() {
  // nb: there is almost certainly a better way to do this, but
  //     since dev recompiles every time, the results of the function
  //     check get thrown out
  const hasSymbol = Object.getOwnPropertySymbols(http.globalAgent).find(
    (s) => s.description === 'cacheableLookupCreateConnection'
  );
  if (!hasSymbol) {
    const cacheable = new CacheableLookup();
    cacheable.install(http.globalAgent);
    cacheable.install(https.globalAgent);
    setGlobalDispatcher(
      new Agent({
        connect: {
          lookup: (hostname, options, callback) => cacheable.lookup(hostname, callback),
        },
      })
    );
  }
}
