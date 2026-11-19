import net from 'net';

const NO_IPV6 = new Set(['EADDRNOTAVAIL', 'EAFNOSUPPORT']);

// Returns an async close().
// allowHalfOpen on both legs: pass an end on instead of cutting the response.
export function openV6Forward(port, log) {
  const sockets = new Set();
  const server = net.createServer({ allowHalfOpen: true }, (client) => {
    const upstream = net.connect({ host: '127.0.0.1', port, allowHalfOpen: true });
    sockets.add(client);
    sockets.add(upstream);
    const drop = () => {
      client.destroy();
      upstream.destroy();
      sockets.delete(client);
      sockets.delete(upstream);
    };
    for (const socket of [client, upstream]) {
      socket.setNoDelay(true);
      socket.on('error', drop).on('close', drop);
    }
    client.pipe(upstream);
    upstream.pipe(client);
  });
  server.on('error', (err) => {
    if (NO_IPV6.has(err.code))
      log('info', `No IPv6 loopback on this machine; [::1]:${port} not served`);
    else log('error', `[::1]:${port} forward failed: ${err.message}`);
  });
  server.listen({ host: '::1', port, ipv6Only: true });

  return () =>
    new Promise((done) => {
      for (const socket of sockets) socket.destroy();
      server.close(() => done());
    });
}
