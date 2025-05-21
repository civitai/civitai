import { NextApiRequest, NextApiResponse } from 'next';
import { Readable } from 'node:stream';
import { env } from '~/env/server';
import client from '~/server/http/nowpayments/nowpayments.caller';

export const config = {
  api: {
    bodyParser: true,
  },
};

async function buffer(readable: Readable) {
  const chunks = [];
  for await (const chunk of readable) {
    chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk);
    console.log('chunk:', chunk);
  }
  return Buffer.concat(chunks);
}

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method === 'POST') {
    const sig = req.headers['x-nowpayments-sig'];

    const webhookSecret = env.TIPALTI_WEBTOKEN_SECRET;
    let event: any;
    // const buf = await buffer(req);

    try {
      if (!sig || !webhookSecret) {
        // only way this is false is if we forgot to include our secret or paddle decides to suddenly not include their signature
        return res.status(400).send({
          error: 'Invalid Request. Signature or Secret not found',
          sig,
        });
      }

      console.log(req.body);
      // const buffAsString = buf.toString('utf8');
      const { isValid, ...data } = client.validateWebhookEvent(sig as string, req.body);
      if (!isValid) {
        console.log('❌ Invalid signature');
        return res.status(400).send({
          error: 'Invalid Request. Could not validate Webhook signature',
          data,
        });
      }

      event = {}; // JSON.parse(buffAsString);

      // switch (event.type) {
      //   default:
      //     throw new Error('Unhandled relevant event!');
      // }
    } catch (error: any) {
      console.log(`❌ Error message: ${error.message}`);
      return res.status(400).send(`Webhook Error: ${error.message}`);
    }

    return res.status(200).json({ received: true });
  } else {
    res.setHeader('Allow', 'POST');
    return res.status(405).end('Method Not Allowed');
  }
}
