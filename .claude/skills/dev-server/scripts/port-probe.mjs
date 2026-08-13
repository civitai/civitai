import net, { createServer } from 'net';

const CONNECT_TIMEOUT_MS = 400;

// A bind-only probe on 127.0.0.1 cannot see most occupied states on Windows: libuv sets
// SO_REUSEADDR unconditionally, and Windows then lets a specific-address bind succeed
// underneath a wildcard listener. Measured against a live `next dev` (which binds `::`
// dual-stack): the probe reported the port free while the server was serving on it.
// Connecting is what distinguishes "nobody is listening" from "I am allowed to bind too".
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
function tryBind(options) {
  return new Promise((resolve) => {
    const server = createServer();
    server.once('error', (err) => {
      resolve(err.code === 'EADDRINUSE' || err.code === 'EACCES' ? 'busy' : 'unsupported');
    });
    server.once('listening', () => {
      server.close(() => resolve('free'));
    });
    server.listen(options);
  });
}

export async function isPortFree(port) {
  if (await canConnect('127.0.0.1', port)) return false;
  if (await canConnect('::1', port)) return false;

  const binds = [
    { port, host: '0.0.0.0', exclusive: true },
    { port, host: '::', ipv6Only: true, exclusive: true },
    { port, exclusive: true },
  ];
  for (const options of binds) {
    if ((await tryBind(options)) === 'busy') return false;
  }
  return true;
}
