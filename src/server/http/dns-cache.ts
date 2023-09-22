import http from 'http';
import https from 'https';
import CacheableLookup from 'cacheable-lookup';
import { Agent, setGlobalDispatcher } from 'undici';

let initialized = false;
export function cacheDnsEntries() {
  if (initialized) return;
  initialized = true;
  console.log('Caching DNS entries...');

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
