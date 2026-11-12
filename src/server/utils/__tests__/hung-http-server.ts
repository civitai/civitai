import { createServer, type Server, type Socket } from 'node:http';
import type { AddressInfo } from 'node:net';

/**
 * A real HTTP server on loopback that accepts every connection and request and never writes a
 * byte back: the shape of a dependency that is up at the TCP level but stalled. A plain `fetch` to
 * it waits for the platform's own header timeout (minutes), so a test that reaches it proves the
 * caller brings its own deadline.
 */
export async function startHungHttpServer(): Promise<{
  url: string;
  requests: () => number;
  close: () => Promise<void>;
}> {
  const sockets = new Set<Socket>();
  let requests = 0;
  const server: Server = createServer(() => {
    requests++; // accept the request, never respond
  });
  server.on('connection', (socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    requests: () => requests,
    close: () =>
      new Promise<void>((resolve) => {
        for (const socket of sockets) socket.destroy();
        server.close(() => resolve());
      }),
  };
}

/** Resolve to `'hung'` if `promise` has not settled within `ms` (real time). */
export function settleOrHung<T>(promise: Promise<T>, ms: number): Promise<T | 'hung'> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const hung = new Promise<'hung'>((resolve) => {
    timer = setTimeout(() => resolve('hung'), ms);
  });
  return Promise.race([promise, hung]).finally(() => clearTimeout(timer));
}
