import net, { createServer } from 'net';

const CONNECT_TIMEOUT_MS = 400;

// Connecting is what distinguishes "nobody is listening" from "I am allowed to bind too".
// A bind-only probe on 127.0.0.1 sees almost nothing on Windows: libuv sets SO_REUSEADDR
// unconditionally, and Windows then lets a specific-address bind succeed underneath a
// wildcard listener. Measured against a live `next dev` (which binds `::` dual-stack) the
// old probe reported the port free while the server was serving on it.
function canConnect(host, port) {
  return new Promise((resolve) => {
    const socket = net.connect({ host, port });
    socket.setTimeout(CONNECT_TIMEOUT_MS);
    socket.on('connect', () => {
      socket.destroy();
      resolve(true);
    });
    socket.on('error', () => resolve(false));
    socket.on('timeout', () => {
      socket.destroy();
      resolve(false);
    });
  });
}

// 'free' | 'busy' | 'unsupported' — a host without IPv6 must not read as a conflict.
//
// Resolving from the `listening` handler rather than from close()'s callback is deliberate:
// close() defers its callback until every accepted connection is gone, and this listener
// accepts anything that arrives in the bind window, so waiting for it would let a single
// stray connection wedge the picker with no timeout above it.
function tryBind(options) {
  return new Promise((resolve) => {
    const server = createServer();
    server.once('error', (err) => {
      resolve(err.code === 'EADDRINUSE' || err.code === 'EACCES' ? 'busy' : 'unsupported');
    });
    server.once('listening', () => {
      server.close();
      resolve('free');
    });
    server.listen(options);
  });
}

export async function isPortFree(port) {
  if (await canConnect('127.0.0.1', port)) return false;
  if (await canConnect('::1', port)) return false;

  // On Windows every occupied state a bind can see, connect already saw — except a port the
  // OS has reserved (EACCES, e.g. a Hyper-V excluded range), which nothing is listening on
  // and `next dev` still cannot have. On Linux the binds are strict and carry real signal.
  //
  // Not covered on Windows: a listener bound to one non-loopback address, which no loopback
  // connect reaches and no wildcard bind conflicts with.
  const binds = [{ port, host: '0.0.0.0' }, { port, host: '::', ipv6Only: true }, { port }];
  for (const options of binds) {
    if ((await tryBind(options)) === 'busy') return false;
  }
  return true;
}
