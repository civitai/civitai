import { initStripePrices, initStripeProducts } from '~/server/services/stripe.service';
import { WebhookEndpoint } from '~/server/utils/endpoint-helpers';

export default WebhookEndpoint(async (req, res) => {
  await initStripeProducts();
  await initStripePrices();

  res.status(200).json({ ok: true });
});
