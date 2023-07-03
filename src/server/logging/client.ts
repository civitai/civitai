import { env } from '~/env/server.mjs';
import { Client } from '@axiomhq/axiom-node';

const shouldConnect = env.AXIOM_TOKEN && env.AXIOM_ORG_ID;
const axiom = shouldConnect
  ? new Client({
      token: env.AXIOM_TOKEN,
      orgId: env.AXIOM_ORG_ID,
    })
  : null;

export async function logToAxiom(data: MixedObject, datastream?: string) {
  if (!axiom) return;
  datastream ??= env.AXIOM_DATASTREAM;
  if (!datastream) return;

  await axiom.ingestEvents(datastream, data);
}
