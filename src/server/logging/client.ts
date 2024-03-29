import { Client } from '@axiomhq/axiom-node';
import { isProd } from '~/env/other';
import { env } from '~/env/server.mjs';

const shouldConnect = env.AXIOM_TOKEN && env.AXIOM_ORG_ID;
const axiom = shouldConnect
  ? new Client({
      token: env.AXIOM_TOKEN,
      orgId: env.AXIOM_ORG_ID,
    })
  : null;

export async function logToAxiom(data: MixedObject, datastream?: string) {
  const sendData = { pod: env.PODNAME, ...data };
  if (isProd) {
    if (!axiom) return;
    datastream ??= env.AXIOM_DATASTREAM;
    if (!datastream) return;

    await axiom.ingestEvents(datastream, sendData);
    // await axiom.ingestEvents(datastream, data);
  } else {
    console.log('logToAxiom', sendData);
    // console.log('logToAxiom', data);
  }
}
