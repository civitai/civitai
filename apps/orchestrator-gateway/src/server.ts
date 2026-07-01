import { buildServer } from './app';

// Entry point. `buildServer` (in app.ts) is the testable factory (no listen); this file only wires the
// listen call so vitest can import the app (via app.ts) without binding a port.
const PORT = Number(process.env.PORT ?? 3000);
const HOST = process.env.HOST ?? '0.0.0.0';

async function main() {
  const app = await buildServer();
  await app.listen({ port: PORT, host: HOST });
  app.log.info(`orchestrator-gateway listening on ${HOST}:${PORT}`);
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error('[orchestrator-gateway] fatal startup error', err);
  process.exit(1);
});
