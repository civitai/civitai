// A minimal fake Postgres server for tests that need a REAL `pg.Pool` / `pg.Client` to lose its
// socket. It speaks just enough of the wire protocol to complete a startup handshake
// (AuthenticationOk + ReadyForQuery) and then lets the test drop connections, either on demand or
// as soon as the client sends a query. That is how a database failover looks to node-postgres: the
// TCP connection ends without a protocol-level goodbye, and pg raises
// `Connection terminated unexpectedly`.
//
// Not a general-purpose server: it never answers a query. Plain TCP only (no SSL negotiation), so
// callers must connect with SSL off.
import net from 'node:net';

export type FakePgServer = {
  /** A connection string pointing at this server. */
  url: string;
  /** Sockets that have completed the startup handshake and are still open. */
  readonly sockets: ReadonlySet<net.Socket>;
  /** Destroy every open client socket (simulates the server going away). */
  dropAll: () => void;
  close: () => Promise<void>;
};

const SSL_REQUEST_CODE = 80877103;

function authOkAndReady(): Buffer {
  // 'R' AuthenticationOk: Int32 len=8, Int32 0
  const auth = Buffer.from([0x52, 0, 0, 0, 8, 0, 0, 0, 0]);
  // 'Z' ReadyForQuery: Int32 len=5, Byte 'I' (idle)
  const ready = Buffer.from([0x5a, 0, 0, 0, 5, 0x49]);
  return Buffer.concat([auth, ready]);
}

/**
 * @param dropOnQuery when true, a socket is destroyed the moment its client sends any message after
 *   startup — i.e. a connection that dies MID-QUERY, while the client is checked out of its pool.
 */
export async function startFakePgServer({ dropOnQuery = false } = {}): Promise<FakePgServer> {
  const sockets = new Set<net.Socket>();

  const server = net.createServer((socket) => {
    let started = false;
    let buf = Buffer.alloc(0);
    socket.on('error', () => {});
    socket.on('close', () => sockets.delete(socket));
    socket.on('data', (chunk) => {
      buf = Buffer.concat([buf, chunk]);
      if (!started) {
        if (buf.length < 8) return;
        const len = buf.readInt32BE(0);
        if (buf.length < len) return;
        const code = buf.readInt32BE(4);
        buf = buf.subarray(len);
        if (code === SSL_REQUEST_CODE) {
          socket.write('N');
          return;
        }
        started = true;
        sockets.add(socket);
        socket.write(authOkAndReady());
        return;
      }
      if (dropOnQuery && buf.length > 0) socket.destroy();
    });
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as net.AddressInfo;

  return {
    url: `postgresql://user:pass@127.0.0.1:${port}/testdb`,
    sockets,
    dropAll: () => {
      for (const s of sockets) s.destroy();
    },
    close: () =>
      new Promise<void>((resolve) => {
        for (const s of sockets) s.destroy();
        server.close(() => resolve());
      }),
  };
}
