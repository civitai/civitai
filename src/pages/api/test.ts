// import Decimal from 'decimal.js';
// import { NextApiRequest, NextApiResponse } from 'next';
// import nowpaymentsCaller from '~/server/http/nowpayments/nowpayments.caller';
// import { PublicEndpoint } from '~/server/utils/endpoint-helpers';

// export default PublicEndpoint(async function (req: NextApiRequest, res: NextApiResponse) {
//   const payment = await nowpaymentsCaller.getPaymentStatus(6240773483);
//   if (!payment) {
//     return res.status(500).json({
//       error: 'Failed to retrieve payment status',
//     });
//   }

//   const estimate = await nowpaymentsCaller.getPriceEstimate({
//     amount: payment?.price_amount as number,
//     currency_from: 'usd', // We only do USD
//     currency_to: payment?.pay_currency as string,
//   });

//   if (!estimate) {
//     return res.status(500).json({
//       error: 'Failed to get estimate',
//     });
//   }

//   const ratio = new Decimal(estimate?.estimated_amount).dividedBy(
//     new Decimal(estimate?.amount_from)
//   );

//   const buzzValueUsd = new Decimal(payment.actually_paid as string | number).dividedBy(ratio);

//   const buzzAmount = Number(payment?.order_id.split('-')[1] as string);
//   const estimateToBuzz = Math.floor(buzzValueUsd.mul(1000).toNumber());
//   const toPay = Math.min(estimateToBuzz, buzzAmount);

//   res.status(200).json({
//     payment,
//     estimate,
//     buzzAmount,
//     estimateToBuzz,
//     toPay,
//     ratio,
//   });
// });
