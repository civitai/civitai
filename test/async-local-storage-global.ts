import { AsyncLocalStorage } from 'node:async_hooks';

// Next captures this global when it first loads and otherwise uses a store that throws; set first so
// a file loading Next early can't hand that store to every later file in its worker.
(globalThis as { AsyncLocalStorage?: typeof AsyncLocalStorage }).AsyncLocalStorage ??=
  AsyncLocalStorage;
