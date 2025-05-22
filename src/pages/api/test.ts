import Decimal from 'decimal.js';
import { NextApiRequest, NextApiResponse } from 'next';
import nowpaymentsCaller from '~/server/http/nowpayments/nowpayments.caller';
import { PublicEndpoint } from '~/server/utils/endpoint-helpers';

// export default PublicEndpoint(async function (req: NextApiRequest, res: NextApiResponse) {
//   const payment = await nowpaymentsCaller.getPaymentStatus();
//   const estimate = await nowpaymentsCaller.getPriceEstimate({
//     amount: payment?.price_amount as number,
//     currency_from: 'usd', // We only do USD
//     currency_to: payment?.outcome_currency as string,
//   });

//   const buzzAmount = Number(payment?.order_id.split('-')[1] as string);
//   const estimateToBuzz = Math.floor(
//     Decimal(estimate?.estimated_amount as string)
//       .mul(1000)
//       .toNumber()
//   );
//   const toPay = Math.min(estimateToBuzz, buzzAmount);

//   res.status(200).json({
//     payment,
//     estimate,
//     buzzAmount,
//     estimateToBuzz,
//     toPay,
//   });
// });
