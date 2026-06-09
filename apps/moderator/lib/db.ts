// The whole point of the monorepo: a second app gets production-grade DB access by
// calling the @civitai/db factory. No connection code, no pool tuning, no env wiring —
// the package owns all of that; this app just supplies its own env values + (optionally)
// injects its own logger/policy. Here we take the defaults.
import { createPrismaClients } from '@civitai/db';

export const { dbRead, dbWrite } = createPrismaClients();
