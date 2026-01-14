/**
 * Query the Buzz Service API directly for users who need prepaids ADDED.
 *
 * This endpoint queries the actual buzz service (not ClickHouse) to verify
 * if transaction data might be missing from ClickHouse.
 *
 * Run with:
 *   GET /api/admin/temp/query-buzz-api-for-add-users?token=WEBHOOK_TOKEN
 *   GET /api/admin/temp/query-buzz-api-for-add-users?token=WEBHOOK_TOKEN&limit=50
 *   GET /api/admin/temp/query-buzz-api-for-add-users?token=WEBHOOK_TOKEN&offset=0&limit=50
 */

import type { NextApiResponse } from 'next';
import { WebhookEndpoint } from '~/server/utils/endpoint-helpers';
import { getUserBuzzTransactions } from '~/server/services/buzz.service';
import dayjs from 'dayjs';

// Users who need prepaids ADDED (adjustmentType === 'add')
// Generated from validate-all-prepaid-memberships-output.json on 2026-01-14
// Total: 428 users
const USERS_NEEDING_ADD: Array<{
  userId: number;
  prepaidsDiff: { bronze: number; silver: number; gold: number };
  clickhouseBonusCount: number;
  clickhouseRefundCount: number;
}> = [
  {
    userId: 7892972,
    prepaidsDiff: { bronze: -1, silver: 0, gold: 0 },
    clickhouseBonusCount: 5,
    clickhouseRefundCount: 0,
  },
  {
    userId: 5433877,
    prepaidsDiff: { bronze: -2, silver: 0, gold: 0 },
    clickhouseBonusCount: 6,
    clickhouseRefundCount: 0,
  },
  {
    userId: 8223533,
    prepaidsDiff: { bronze: -1, silver: 0, gold: 0 },
    clickhouseBonusCount: 6,
    clickhouseRefundCount: 0,
  },
  {
    userId: 1054209,
    prepaidsDiff: { bronze: -2, silver: 0, gold: 0 },
    clickhouseBonusCount: 5,
    clickhouseRefundCount: 0,
  },
  {
    userId: 5044315,
    prepaidsDiff: { bronze: -1, silver: 0, gold: 0 },
    clickhouseBonusCount: 7,
    clickhouseRefundCount: 0,
  },
  {
    userId: 8082049,
    prepaidsDiff: { bronze: 0, silver: -2, gold: 0 },
    clickhouseBonusCount: 5,
    clickhouseRefundCount: 0,
  },
  {
    userId: 3493364,
    prepaidsDiff: { bronze: -2, silver: 0, gold: 0 },
    clickhouseBonusCount: 7,
    clickhouseRefundCount: 0,
  },
  {
    userId: 5489975,
    prepaidsDiff: { bronze: -2, silver: 0, gold: 0 },
    clickhouseBonusCount: 7,
    clickhouseRefundCount: 0,
  },
  {
    userId: 9671113,
    prepaidsDiff: { bronze: -1, silver: 0, gold: 0 },
    clickhouseBonusCount: 5,
    clickhouseRefundCount: 0,
  },
  {
    userId: 8926940,
    prepaidsDiff: { bronze: -1, silver: 0, gold: 0 },
    clickhouseBonusCount: 5,
    clickhouseRefundCount: 0,
  },
  {
    userId: 7802738,
    prepaidsDiff: { bronze: 0, silver: -2, gold: 0 },
    clickhouseBonusCount: 6,
    clickhouseRefundCount: 2,
  },
  {
    userId: 7931203,
    prepaidsDiff: { bronze: -1, silver: 0, gold: 0 },
    clickhouseBonusCount: 6,
    clickhouseRefundCount: 0,
  },
  {
    userId: 9363165,
    prepaidsDiff: { bronze: 0, silver: -1, gold: 0 },
    clickhouseBonusCount: 6,
    clickhouseRefundCount: 2,
  },
  {
    userId: 6918650,
    prepaidsDiff: { bronze: 0, silver: -2, gold: 0 },
    clickhouseBonusCount: 5,
    clickhouseRefundCount: 0,
  },
  {
    userId: 9750629,
    prepaidsDiff: { bronze: 0, silver: -2, gold: 0 },
    clickhouseBonusCount: 5,
    clickhouseRefundCount: 0,
  },
  {
    userId: 3025821,
    prepaidsDiff: { bronze: -1, silver: 0, gold: 0 },
    clickhouseBonusCount: 5,
    clickhouseRefundCount: 0,
  },
  {
    userId: 1986679,
    prepaidsDiff: { bronze: -1, silver: 0, gold: 0 },
    clickhouseBonusCount: 5,
    clickhouseRefundCount: 0,
  },
  {
    userId: 6085524,
    prepaidsDiff: { bronze: -1, silver: 0, gold: 0 },
    clickhouseBonusCount: 3,
    clickhouseRefundCount: 0,
  },
  {
    userId: 6663632,
    prepaidsDiff: { bronze: -1, silver: 0, gold: 0 },
    clickhouseBonusCount: 6,
    clickhouseRefundCount: 1,
  },
  {
    userId: 3810871,
    prepaidsDiff: { bronze: -2, silver: 0, gold: 0 },
    clickhouseBonusCount: 6,
    clickhouseRefundCount: 2,
  },
  {
    userId: 6689752,
    prepaidsDiff: { bronze: -2, silver: 0, gold: 0 },
    clickhouseBonusCount: 5,
    clickhouseRefundCount: 0,
  },
  {
    userId: 6390505,
    prepaidsDiff: { bronze: -1, silver: 0, gold: 0 },
    clickhouseBonusCount: 6,
    clickhouseRefundCount: 0,
  },
  {
    userId: 3239328,
    prepaidsDiff: { bronze: 0, silver: -1, gold: 0 },
    clickhouseBonusCount: 6,
    clickhouseRefundCount: 0,
  },
  {
    userId: 4574063,
    prepaidsDiff: { bronze: 0, silver: -1, gold: 0 },
    clickhouseBonusCount: 5,
    clickhouseRefundCount: 0,
  },
  {
    userId: 5298987,
    prepaidsDiff: { bronze: -1, silver: 0, gold: 0 },
    clickhouseBonusCount: 3,
    clickhouseRefundCount: 0,
  },
  {
    userId: 9676479,
    prepaidsDiff: { bronze: -1, silver: 0, gold: 0 },
    clickhouseBonusCount: 3,
    clickhouseRefundCount: 0,
  },
  {
    userId: 4552597,
    prepaidsDiff: { bronze: 0, silver: -1, gold: 0 },
    clickhouseBonusCount: 5,
    clickhouseRefundCount: 0,
  },
  {
    userId: 9605653,
    prepaidsDiff: { bronze: -1, silver: 0, gold: 0 },
    clickhouseBonusCount: 6,
    clickhouseRefundCount: 0,
  },
  {
    userId: 7925573,
    prepaidsDiff: { bronze: -2, silver: 0, gold: 0 },
    clickhouseBonusCount: 3,
    clickhouseRefundCount: 0,
  },
  {
    userId: 8070327,
    prepaidsDiff: { bronze: -1, silver: 0, gold: 0 },
    clickhouseBonusCount: 4,
    clickhouseRefundCount: 0,
  },
  {
    userId: 4242608,
    prepaidsDiff: { bronze: -1, silver: 0, gold: 0 },
    clickhouseBonusCount: 5,
    clickhouseRefundCount: 0,
  },
  {
    userId: 4041336,
    prepaidsDiff: { bronze: -1, silver: 0, gold: 0 },
    clickhouseBonusCount: 6,
    clickhouseRefundCount: 0,
  },
  {
    userId: 6666329,
    prepaidsDiff: { bronze: -2, silver: 0, gold: 0 },
    clickhouseBonusCount: 6,
    clickhouseRefundCount: 2,
  },
  {
    userId: 8728615,
    prepaidsDiff: { bronze: -2, silver: 0, gold: 0 },
    clickhouseBonusCount: 5,
    clickhouseRefundCount: 2,
  },
  {
    userId: 6122259,
    prepaidsDiff: { bronze: -1, silver: 0, gold: 0 },
    clickhouseBonusCount: 5,
    clickhouseRefundCount: 0,
  },
  {
    userId: 5060898,
    prepaidsDiff: { bronze: -2, silver: 0, gold: 0 },
    clickhouseBonusCount: 5,
    clickhouseRefundCount: 0,
  },
  {
    userId: 7922776,
    prepaidsDiff: { bronze: 0, silver: -2, gold: 0 },
    clickhouseBonusCount: 5,
    clickhouseRefundCount: 0,
  },
  {
    userId: 5238994,
    prepaidsDiff: { bronze: -2, silver: 0, gold: 0 },
    clickhouseBonusCount: 5,
    clickhouseRefundCount: 0,
  },
  {
    userId: 1407448,
    prepaidsDiff: { bronze: 0, silver: -1, gold: 0 },
    clickhouseBonusCount: 5,
    clickhouseRefundCount: 0,
  },
  {
    userId: 9518845,
    prepaidsDiff: { bronze: -1, silver: 0, gold: 0 },
    clickhouseBonusCount: 6,
    clickhouseRefundCount: 2,
  },
  {
    userId: 7482007,
    prepaidsDiff: { bronze: -1, silver: 0, gold: 0 },
    clickhouseBonusCount: 6,
    clickhouseRefundCount: 0,
  },
  {
    userId: 3699775,
    prepaidsDiff: { bronze: -1, silver: 0, gold: 0 },
    clickhouseBonusCount: 6,
    clickhouseRefundCount: 0,
  },
  {
    userId: 9619756,
    prepaidsDiff: { bronze: -2, silver: 0, gold: 0 },
    clickhouseBonusCount: 5,
    clickhouseRefundCount: 0,
  },
  {
    userId: 5141754,
    prepaidsDiff: { bronze: -2, silver: 0, gold: 0 },
    clickhouseBonusCount: 5,
    clickhouseRefundCount: 0,
  },
  {
    userId: 5551999,
    prepaidsDiff: { bronze: -2, silver: 0, gold: 0 },
    clickhouseBonusCount: 5,
    clickhouseRefundCount: 0,
  },
  {
    userId: 2377354,
    prepaidsDiff: { bronze: -2, silver: 0, gold: 0 },
    clickhouseBonusCount: 5,
    clickhouseRefundCount: 0,
  },
  {
    userId: 7241967,
    prepaidsDiff: { bronze: -1, silver: 0, gold: 0 },
    clickhouseBonusCount: 5,
    clickhouseRefundCount: 0,
  },
  {
    userId: 6638110,
    prepaidsDiff: { bronze: -1, silver: 0, gold: 0 },
    clickhouseBonusCount: 5,
    clickhouseRefundCount: 0,
  },
  {
    userId: 3585773,
    prepaidsDiff: { bronze: -2, silver: 0, gold: 0 },
    clickhouseBonusCount: 4,
    clickhouseRefundCount: 0,
  },
  {
    userId: 9363646,
    prepaidsDiff: { bronze: -1, silver: 0, gold: 0 },
    clickhouseBonusCount: 5,
    clickhouseRefundCount: 0,
  },
  {
    userId: 5425469,
    prepaidsDiff: { bronze: -1, silver: 0, gold: 0 },
    clickhouseBonusCount: 5,
    clickhouseRefundCount: 1,
  },
  {
    userId: 5048857,
    prepaidsDiff: { bronze: 0, silver: -2, gold: 0 },
    clickhouseBonusCount: 5,
    clickhouseRefundCount: 0,
  },
  {
    userId: 9514834,
    prepaidsDiff: { bronze: -2, silver: 0, gold: 0 },
    clickhouseBonusCount: 5,
    clickhouseRefundCount: 0,
  },
  {
    userId: 8867300,
    prepaidsDiff: { bronze: -2, silver: 0, gold: 0 },
    clickhouseBonusCount: 5,
    clickhouseRefundCount: 0,
  },
  {
    userId: 8272825,
    prepaidsDiff: { bronze: -1, silver: 0, gold: 0 },
    clickhouseBonusCount: 5,
    clickhouseRefundCount: 0,
  },
  {
    userId: 6410481,
    prepaidsDiff: { bronze: -2, silver: 0, gold: 0 },
    clickhouseBonusCount: 2,
    clickhouseRefundCount: 0,
  },
  {
    userId: 5958697,
    prepaidsDiff: { bronze: -2, silver: 0, gold: 0 },
    clickhouseBonusCount: 5,
    clickhouseRefundCount: 0,
  },
  {
    userId: 4580265,
    prepaidsDiff: { bronze: -2, silver: 0, gold: 0 },
    clickhouseBonusCount: 5,
    clickhouseRefundCount: 0,
  },
  {
    userId: 9886820,
    prepaidsDiff: { bronze: -2, silver: 0, gold: 0 },
    clickhouseBonusCount: 5,
    clickhouseRefundCount: 0,
  },
  {
    userId: 2427555,
    prepaidsDiff: { bronze: -2, silver: 0, gold: 0 },
    clickhouseBonusCount: 5,
    clickhouseRefundCount: 0,
  },
  {
    userId: 4521633,
    prepaidsDiff: { bronze: -1, silver: 0, gold: 0 },
    clickhouseBonusCount: 5,
    clickhouseRefundCount: 0,
  },
  {
    userId: 7514403,
    prepaidsDiff: { bronze: -1, silver: 0, gold: 0 },
    clickhouseBonusCount: 6,
    clickhouseRefundCount: 0,
  },
  {
    userId: 6112246,
    prepaidsDiff: { bronze: -1, silver: 0, gold: 0 },
    clickhouseBonusCount: 5,
    clickhouseRefundCount: 0,
  },
  {
    userId: 9085860,
    prepaidsDiff: { bronze: -2, silver: 0, gold: 0 },
    clickhouseBonusCount: 5,
    clickhouseRefundCount: 0,
  },
  {
    userId: 5761849,
    prepaidsDiff: { bronze: -2, silver: 0, gold: 0 },
    clickhouseBonusCount: 6,
    clickhouseRefundCount: 0,
  },
  {
    userId: 6893258,
    prepaidsDiff: { bronze: -1, silver: 0, gold: 0 },
    clickhouseBonusCount: 5,
    clickhouseRefundCount: 0,
  },
  {
    userId: 8125189,
    prepaidsDiff: { bronze: -2, silver: 0, gold: 0 },
    clickhouseBonusCount: 5,
    clickhouseRefundCount: 0,
  },
  {
    userId: 4990975,
    prepaidsDiff: { bronze: -2, silver: 0, gold: 0 },
    clickhouseBonusCount: 5,
    clickhouseRefundCount: 0,
  },
  {
    userId: 120157,
    prepaidsDiff: { bronze: -1, silver: 0, gold: 0 },
    clickhouseBonusCount: 5,
    clickhouseRefundCount: 0,
  },
  {
    userId: 10090850,
    prepaidsDiff: { bronze: -1, silver: 0, gold: 0 },
    clickhouseBonusCount: 4,
    clickhouseRefundCount: 0,
  },
  {
    userId: 1807715,
    prepaidsDiff: { bronze: -1, silver: 0, gold: 0 },
    clickhouseBonusCount: 5,
    clickhouseRefundCount: 0,
  },
  {
    userId: 4914120,
    prepaidsDiff: { bronze: -1, silver: 0, gold: 0 },
    clickhouseBonusCount: 2,
    clickhouseRefundCount: 0,
  },
  {
    userId: 4532297,
    prepaidsDiff: { bronze: -1, silver: 0, gold: 0 },
    clickhouseBonusCount: 2,
    clickhouseRefundCount: 0,
  },
  {
    userId: 4255297,
    prepaidsDiff: { bronze: -1, silver: 0, gold: 0 },
    clickhouseBonusCount: 2,
    clickhouseRefundCount: 0,
  },
  {
    userId: 5488469,
    prepaidsDiff: { bronze: -2, silver: 0, gold: 0 },
    clickhouseBonusCount: 6,
    clickhouseRefundCount: 2,
  },
  {
    userId: 9658157,
    prepaidsDiff: { bronze: -2, silver: 0, gold: 0 },
    clickhouseBonusCount: 6,
    clickhouseRefundCount: 2,
  },
  {
    userId: 5376453,
    prepaidsDiff: { bronze: -2, silver: 0, gold: 0 },
    clickhouseBonusCount: 6,
    clickhouseRefundCount: 2,
  },
  {
    userId: 9175344,
    prepaidsDiff: { bronze: -1, silver: -1, gold: 0 },
    clickhouseBonusCount: 4,
    clickhouseRefundCount: 0,
  },
  {
    userId: 4737436,
    prepaidsDiff: { bronze: 0, silver: -1, gold: 0 },
    clickhouseBonusCount: 6,
    clickhouseRefundCount: 0,
  },
  {
    userId: 18085,
    prepaidsDiff: { bronze: 0, silver: -9, gold: 0 },
    clickhouseBonusCount: 9,
    clickhouseRefundCount: 0,
  },
  {
    userId: 6445543,
    prepaidsDiff: { bronze: -1, silver: 0, gold: 0 },
    clickhouseBonusCount: 7,
    clickhouseRefundCount: 0,
  },
  {
    userId: 4712067,
    prepaidsDiff: { bronze: 0, silver: -1, gold: 0 },
    clickhouseBonusCount: 6,
    clickhouseRefundCount: 0,
  },
  {
    userId: 5840667,
    prepaidsDiff: { bronze: -1, silver: 0, gold: 0 },
    clickhouseBonusCount: 6,
    clickhouseRefundCount: 0,
  },
  {
    userId: 6029865,
    prepaidsDiff: { bronze: -1, silver: 0, gold: 0 },
    clickhouseBonusCount: 5,
    clickhouseRefundCount: 0,
  },
  {
    userId: 6187612,
    prepaidsDiff: { bronze: -1, silver: 0, gold: 0 },
    clickhouseBonusCount: 6,
    clickhouseRefundCount: 0,
  },
  {
    userId: 9603573,
    prepaidsDiff: { bronze: -1, silver: 0, gold: 0 },
    clickhouseBonusCount: 5,
    clickhouseRefundCount: 0,
  },
  {
    userId: 2205745,
    prepaidsDiff: { bronze: -1, silver: 0, gold: 0 },
    clickhouseBonusCount: 5,
    clickhouseRefundCount: 0,
  },
  {
    userId: 6048273,
    prepaidsDiff: { bronze: -1, silver: 0, gold: 0 },
    clickhouseBonusCount: 7,
    clickhouseRefundCount: 0,
  },
  {
    userId: 3005508,
    prepaidsDiff: { bronze: -1, silver: 0, gold: 0 },
    clickhouseBonusCount: 7,
    clickhouseRefundCount: 0,
  },
  {
    userId: 1879796,
    prepaidsDiff: { bronze: -1, silver: -1, gold: 0 },
    clickhouseBonusCount: 6,
    clickhouseRefundCount: 0,
  },
  {
    userId: 9893619,
    prepaidsDiff: { bronze: 0, silver: -1, gold: 0 },
    clickhouseBonusCount: 5,
    clickhouseRefundCount: 0,
  },
  {
    userId: 5291036,
    prepaidsDiff: { bronze: 0, silver: 0, gold: -1 },
    clickhouseBonusCount: 4,
    clickhouseRefundCount: 0,
  },
  {
    userId: 5418,
    prepaidsDiff: { bronze: 0, silver: 0, gold: -1 },
    clickhouseBonusCount: 7,
    clickhouseRefundCount: 0,
  },
  {
    userId: 2222444,
    prepaidsDiff: { bronze: -1, silver: 0, gold: 0 },
    clickhouseBonusCount: 3,
    clickhouseRefundCount: 0,
  },
  {
    userId: 6124887,
    prepaidsDiff: { bronze: 0, silver: -1, gold: 0 },
    clickhouseBonusCount: 5,
    clickhouseRefundCount: 0,
  },
  {
    userId: 2330151,
    prepaidsDiff: { bronze: -1, silver: 0, gold: 0 },
    clickhouseBonusCount: 6,
    clickhouseRefundCount: 0,
  },
  {
    userId: 1822361,
    prepaidsDiff: { bronze: -1, silver: 0, gold: 0 },
    clickhouseBonusCount: 5,
    clickhouseRefundCount: 0,
  },
  {
    userId: 832746,
    prepaidsDiff: { bronze: -1, silver: 0, gold: 0 },
    clickhouseBonusCount: 5,
    clickhouseRefundCount: 0,
  },
  {
    userId: 3409741,
    prepaidsDiff: { bronze: -1, silver: 0, gold: 0 },
    clickhouseBonusCount: 6,
    clickhouseRefundCount: 0,
  },
  {
    userId: 1966138,
    prepaidsDiff: { bronze: 0, silver: -1, gold: 0 },
    clickhouseBonusCount: 6,
    clickhouseRefundCount: 0,
  },
  {
    userId: 6901045,
    prepaidsDiff: { bronze: 0, silver: 0, gold: -1 },
    clickhouseBonusCount: 3,
    clickhouseRefundCount: 0,
  },
  {
    userId: 7636165,
    prepaidsDiff: { bronze: -2, silver: 0, gold: 0 },
    clickhouseBonusCount: 7,
    clickhouseRefundCount: 0,
  },
  {
    userId: 3916904,
    prepaidsDiff: { bronze: 0, silver: -1, gold: 0 },
    clickhouseBonusCount: 6,
    clickhouseRefundCount: 0,
  },
  {
    userId: 3356664,
    prepaidsDiff: { bronze: -1, silver: 0, gold: 0 },
    clickhouseBonusCount: 6,
    clickhouseRefundCount: 0,
  },
  {
    userId: 2179540,
    prepaidsDiff: { bronze: -1, silver: 0, gold: 0 },
    clickhouseBonusCount: 6,
    clickhouseRefundCount: 2,
  },
  {
    userId: 4989900,
    prepaidsDiff: { bronze: -1, silver: 0, gold: 0 },
    clickhouseBonusCount: 5,
    clickhouseRefundCount: 0,
  },
  {
    userId: 61497,
    prepaidsDiff: { bronze: 0, silver: 0, gold: -1 },
    clickhouseBonusCount: 4,
    clickhouseRefundCount: 0,
  },
  {
    userId: 3528392,
    prepaidsDiff: { bronze: 0, silver: -1, gold: 0 },
    clickhouseBonusCount: 6,
    clickhouseRefundCount: 0,
  },
  {
    userId: 3480499,
    prepaidsDiff: { bronze: 0, silver: -1, gold: 0 },
    clickhouseBonusCount: 6,
    clickhouseRefundCount: 2,
  },
  {
    userId: 4859832,
    prepaidsDiff: { bronze: 0, silver: 0, gold: -1 },
    clickhouseBonusCount: 5,
    clickhouseRefundCount: 0,
  },
  {
    userId: 9320605,
    prepaidsDiff: { bronze: -1, silver: 0, gold: 0 },
    clickhouseBonusCount: 6,
    clickhouseRefundCount: 1,
  },
  {
    userId: 6108745,
    prepaidsDiff: { bronze: 0, silver: 0, gold: -1 },
    clickhouseBonusCount: 7,
    clickhouseRefundCount: 0,
  },
  {
    userId: 8405395,
    prepaidsDiff: { bronze: -1, silver: 0, gold: 0 },
    clickhouseBonusCount: 6,
    clickhouseRefundCount: 1,
  },
  {
    userId: 8807490,
    prepaidsDiff: { bronze: 0, silver: 0, gold: -1 },
    clickhouseBonusCount: 3,
    clickhouseRefundCount: 0,
  },
  {
    userId: 6595900,
    prepaidsDiff: { bronze: 0, silver: 0, gold: -1 },
    clickhouseBonusCount: 6,
    clickhouseRefundCount: 2,
  },
  {
    userId: 3725145,
    prepaidsDiff: { bronze: 0, silver: -1, gold: 0 },
    clickhouseBonusCount: 6,
    clickhouseRefundCount: 0,
  },
  {
    userId: 7017889,
    prepaidsDiff: { bronze: -1, silver: 0, gold: 0 },
    clickhouseBonusCount: 6,
    clickhouseRefundCount: 0,
  },
  {
    userId: 6924539,
    prepaidsDiff: { bronze: 0, silver: -1, gold: 0 },
    clickhouseBonusCount: 4,
    clickhouseRefundCount: 0,
  },
  {
    userId: 6228280,
    prepaidsDiff: { bronze: 0, silver: 0, gold: -2 },
    clickhouseBonusCount: 7,
    clickhouseRefundCount: 0,
  },
  {
    userId: 3842180,
    prepaidsDiff: { bronze: -1, silver: 0, gold: 0 },
    clickhouseBonusCount: 6,
    clickhouseRefundCount: 0,
  },
  {
    userId: 42796,
    prepaidsDiff: { bronze: -1, silver: 0, gold: 0 },
    clickhouseBonusCount: 6,
    clickhouseRefundCount: 2,
  },
  {
    userId: 5971420,
    prepaidsDiff: { bronze: -1, silver: 0, gold: 0 },
    clickhouseBonusCount: 6,
    clickhouseRefundCount: 0,
  },
  {
    userId: 10321970,
    prepaidsDiff: { bronze: 0, silver: -1, gold: 0 },
    clickhouseBonusCount: 3,
    clickhouseRefundCount: 0,
  },
  {
    userId: 7967091,
    prepaidsDiff: { bronze: -1, silver: -1, gold: 0 },
    clickhouseBonusCount: 3,
    clickhouseRefundCount: 0,
  },
  {
    userId: 3628635,
    prepaidsDiff: { bronze: -1, silver: 0, gold: 0 },
    clickhouseBonusCount: 7,
    clickhouseRefundCount: 0,
  },
  {
    userId: 1336501,
    prepaidsDiff: { bronze: -1, silver: 0, gold: 0 },
    clickhouseBonusCount: 6,
    clickhouseRefundCount: 0,
  },
  {
    userId: 1377768,
    prepaidsDiff: { bronze: -1, silver: 0, gold: 0 },
    clickhouseBonusCount: 6,
    clickhouseRefundCount: 1,
  },
  {
    userId: 10337385,
    prepaidsDiff: { bronze: 0, silver: 0, gold: -1 },
    clickhouseBonusCount: 3,
    clickhouseRefundCount: 0,
  },
  {
    userId: 6421565,
    prepaidsDiff: { bronze: 0, silver: -1, gold: 0 },
    clickhouseBonusCount: 6,
    clickhouseRefundCount: 0,
  },
  {
    userId: 5604912,
    prepaidsDiff: { bronze: 0, silver: -1, gold: 0 },
    clickhouseBonusCount: 5,
    clickhouseRefundCount: 0,
  },
  {
    userId: 628464,
    prepaidsDiff: { bronze: -1, silver: 0, gold: 0 },
    clickhouseBonusCount: 3,
    clickhouseRefundCount: 0,
  },
  {
    userId: 7182172,
    prepaidsDiff: { bronze: -1, silver: 0, gold: 0 },
    clickhouseBonusCount: 2,
    clickhouseRefundCount: 0,
  },
  {
    userId: 10623005,
    prepaidsDiff: { bronze: -1, silver: 0, gold: 0 },
    clickhouseBonusCount: 2,
    clickhouseRefundCount: 0,
  },
  {
    userId: 10596334,
    prepaidsDiff: { bronze: -1, silver: 0, gold: 0 },
    clickhouseBonusCount: 2,
    clickhouseRefundCount: 0,
  },
  {
    userId: 7446420,
    prepaidsDiff: { bronze: -1, silver: 0, gold: 0 },
    clickhouseBonusCount: 2,
    clickhouseRefundCount: 0,
  },
  {
    userId: 10368522,
    prepaidsDiff: { bronze: -1, silver: 0, gold: 0 },
    clickhouseBonusCount: 2,
    clickhouseRefundCount: 0,
  },
  {
    userId: 3654923,
    prepaidsDiff: { bronze: -1, silver: 0, gold: 0 },
    clickhouseBonusCount: 2,
    clickhouseRefundCount: 0,
  },
  {
    userId: 5756333,
    prepaidsDiff: { bronze: -1, silver: 0, gold: 0 },
    clickhouseBonusCount: 6,
    clickhouseRefundCount: 0,
  },
  {
    userId: 2203278,
    prepaidsDiff: { bronze: -1, silver: 0, gold: 0 },
    clickhouseBonusCount: 7,
    clickhouseRefundCount: 0,
  },
  {
    userId: 10061079,
    prepaidsDiff: { bronze: 0, silver: -1, gold: 0 },
    clickhouseBonusCount: 4,
    clickhouseRefundCount: 0,
  },
  {
    userId: 4277151,
    prepaidsDiff: { bronze: -1, silver: 0, gold: 0 },
    clickhouseBonusCount: 6,
    clickhouseRefundCount: 0,
  },
  {
    userId: 3265064,
    prepaidsDiff: { bronze: 0, silver: 0, gold: -1 },
    clickhouseBonusCount: 6,
    clickhouseRefundCount: 2,
  },
  {
    userId: 1419526,
    prepaidsDiff: { bronze: -1, silver: 0, gold: 0 },
    clickhouseBonusCount: 7,
    clickhouseRefundCount: 0,
  },
  {
    userId: 6488105,
    prepaidsDiff: { bronze: 0, silver: 0, gold: -1 },
    clickhouseBonusCount: 7,
    clickhouseRefundCount: 0,
  },
  {
    userId: 5886059,
    prepaidsDiff: { bronze: -1, silver: 0, gold: 0 },
    clickhouseBonusCount: 6,
    clickhouseRefundCount: 2,
  },
  {
    userId: 6712826,
    prepaidsDiff: { bronze: -1, silver: 0, gold: 0 },
    clickhouseBonusCount: 6,
    clickhouseRefundCount: 2,
  },
  {
    userId: 10784906,
    prepaidsDiff: { bronze: -1, silver: 0, gold: 0 },
    clickhouseBonusCount: 2,
    clickhouseRefundCount: 0,
  },
  {
    userId: 7623855,
    prepaidsDiff: { bronze: 0, silver: 0, gold: -1 },
    clickhouseBonusCount: 6,
    clickhouseRefundCount: 2,
  },
  {
    userId: 8126375,
    prepaidsDiff: { bronze: 0, silver: 0, gold: -1 },
    clickhouseBonusCount: 5,
    clickhouseRefundCount: 0,
  },
  {
    userId: 9632801,
    prepaidsDiff: { bronze: -1, silver: 0, gold: 0 },
    clickhouseBonusCount: 6,
    clickhouseRefundCount: 0,
  },
  {
    userId: 2730091,
    prepaidsDiff: { bronze: 0, silver: -1, gold: 0 },
    clickhouseBonusCount: 6,
    clickhouseRefundCount: 0,
  },
  {
    userId: 7298882,
    prepaidsDiff: { bronze: 0, silver: -1, gold: 0 },
    clickhouseBonusCount: 6,
    clickhouseRefundCount: 0,
  },
  {
    userId: 2108863,
    prepaidsDiff: { bronze: 0, silver: -1, gold: 0 },
    clickhouseBonusCount: 6,
    clickhouseRefundCount: 0,
  },
  {
    userId: 9130572,
    prepaidsDiff: { bronze: -1, silver: 0, gold: 0 },
    clickhouseBonusCount: 6,
    clickhouseRefundCount: 0,
  },
  {
    userId: 7094927,
    prepaidsDiff: { bronze: -2, silver: 0, gold: 0 },
    clickhouseBonusCount: 4,
    clickhouseRefundCount: 0,
  },
  {
    userId: 7347579,
    prepaidsDiff: { bronze: -2, silver: 0, gold: 0 },
    clickhouseBonusCount: 6,
    clickhouseRefundCount: 2,
  },
  {
    userId: 2123507,
    prepaidsDiff: { bronze: 0, silver: -1, gold: 0 },
    clickhouseBonusCount: 6,
    clickhouseRefundCount: 2,
  },
  {
    userId: 8119987,
    prepaidsDiff: { bronze: 0, silver: 0, gold: -2 },
    clickhouseBonusCount: 7,
    clickhouseRefundCount: 0,
  },
  {
    userId: 2254652,
    prepaidsDiff: { bronze: -1, silver: 0, gold: 0 },
    clickhouseBonusCount: 6,
    clickhouseRefundCount: 0,
  },
  {
    userId: 2862407,
    prepaidsDiff: { bronze: -1, silver: 0, gold: 0 },
    clickhouseBonusCount: 7,
    clickhouseRefundCount: 0,
  },
  {
    userId: 4500757,
    prepaidsDiff: { bronze: -1, silver: 0, gold: 0 },
    clickhouseBonusCount: 3,
    clickhouseRefundCount: 0,
  },
  {
    userId: 4898764,
    prepaidsDiff: { bronze: -1, silver: 0, gold: 0 },
    clickhouseBonusCount: 6,
    clickhouseRefundCount: 0,
  },
  {
    userId: 8914711,
    prepaidsDiff: { bronze: -1, silver: 0, gold: 0 },
    clickhouseBonusCount: 5,
    clickhouseRefundCount: 1,
  },
  {
    userId: 5861440,
    prepaidsDiff: { bronze: -1, silver: 0, gold: 0 },
    clickhouseBonusCount: 5,
    clickhouseRefundCount: 0,
  },
  {
    userId: 7997261,
    prepaidsDiff: { bronze: -2, silver: 0, gold: 0 },
    clickhouseBonusCount: 5,
    clickhouseRefundCount: 0,
  },
  {
    userId: 103270,
    prepaidsDiff: { bronze: 0, silver: 0, gold: -1 },
    clickhouseBonusCount: 3,
    clickhouseRefundCount: 0,
  },
  {
    userId: 4884212,
    prepaidsDiff: { bronze: -1, silver: 0, gold: 0 },
    clickhouseBonusCount: 5,
    clickhouseRefundCount: 0,
  },
  {
    userId: 785932,
    prepaidsDiff: { bronze: -1, silver: 0, gold: 0 },
    clickhouseBonusCount: 4,
    clickhouseRefundCount: 0,
  },
  {
    userId: 8221577,
    prepaidsDiff: { bronze: -1, silver: 0, gold: 0 },
    clickhouseBonusCount: 5,
    clickhouseRefundCount: 0,
  },
  {
    userId: 6667292,
    prepaidsDiff: { bronze: -1, silver: 0, gold: 0 },
    clickhouseBonusCount: 4,
    clickhouseRefundCount: 0,
  },
  {
    userId: 5211909,
    prepaidsDiff: { bronze: -1, silver: 0, gold: 0 },
    clickhouseBonusCount: 6,
    clickhouseRefundCount: 0,
  },
  {
    userId: 1118432,
    prepaidsDiff: { bronze: -1, silver: 0, gold: 0 },
    clickhouseBonusCount: 4,
    clickhouseRefundCount: 0,
  },
  {
    userId: 9590651,
    prepaidsDiff: { bronze: -1, silver: 0, gold: 0 },
    clickhouseBonusCount: 5,
    clickhouseRefundCount: 0,
  },
  {
    userId: 9895805,
    prepaidsDiff: { bronze: -2, silver: 0, gold: 0 },
    clickhouseBonusCount: 4,
    clickhouseRefundCount: 0,
  },
  {
    userId: 7495912,
    prepaidsDiff: { bronze: -1, silver: 0, gold: 0 },
    clickhouseBonusCount: 5,
    clickhouseRefundCount: 0,
  },
  {
    userId: 1462198,
    prepaidsDiff: { bronze: 0, silver: -2, gold: 0 },
    clickhouseBonusCount: 5,
    clickhouseRefundCount: 0,
  },
  {
    userId: 7881334,
    prepaidsDiff: { bronze: 0, silver: -1, gold: 0 },
    clickhouseBonusCount: 5,
    clickhouseRefundCount: 0,
  },
  {
    userId: 4113619,
    prepaidsDiff: { bronze: -1, silver: 0, gold: 0 },
    clickhouseBonusCount: 5,
    clickhouseRefundCount: 0,
  },
  {
    userId: 3048555,
    prepaidsDiff: { bronze: -2, silver: 0, gold: 0 },
    clickhouseBonusCount: 3,
    clickhouseRefundCount: 0,
  },
  {
    userId: 8835176,
    prepaidsDiff: { bronze: -1, silver: 0, gold: 0 },
    clickhouseBonusCount: 4,
    clickhouseRefundCount: 0,
  },
  {
    userId: 8178045,
    prepaidsDiff: { bronze: -1, silver: 0, gold: 0 },
    clickhouseBonusCount: 6,
    clickhouseRefundCount: 0,
  },
  {
    userId: 6140,
    prepaidsDiff: { bronze: -2, silver: 0, gold: 0 },
    clickhouseBonusCount: 5,
    clickhouseRefundCount: 0,
  },
  {
    userId: 45263,
    prepaidsDiff: { bronze: -1, silver: 0, gold: 0 },
    clickhouseBonusCount: 6,
    clickhouseRefundCount: 2,
  },
  {
    userId: 9382272,
    prepaidsDiff: { bronze: -1, silver: 0, gold: 0 },
    clickhouseBonusCount: 6,
    clickhouseRefundCount: 2,
  },
  {
    userId: 8280911,
    prepaidsDiff: { bronze: 0, silver: -1, gold: 0 },
    clickhouseBonusCount: 5,
    clickhouseRefundCount: 0,
  },
  {
    userId: 6643247,
    prepaidsDiff: { bronze: -1, silver: 0, gold: 0 },
    clickhouseBonusCount: 3,
    clickhouseRefundCount: 0,
  },
  {
    userId: 3870597,
    prepaidsDiff: { bronze: -1, silver: 0, gold: 0 },
    clickhouseBonusCount: 6,
    clickhouseRefundCount: 2,
  },
  {
    userId: 5171378,
    prepaidsDiff: { bronze: -1, silver: 0, gold: 0 },
    clickhouseBonusCount: 6,
    clickhouseRefundCount: 2,
  },
  {
    userId: 2951235,
    prepaidsDiff: { bronze: -1, silver: 0, gold: 0 },
    clickhouseBonusCount: 6,
    clickhouseRefundCount: 2,
  },
  {
    userId: 1396061,
    prepaidsDiff: { bronze: 0, silver: -1, gold: 0 },
    clickhouseBonusCount: 5,
    clickhouseRefundCount: 0,
  },
  {
    userId: 7461066,
    prepaidsDiff: { bronze: -1, silver: 0, gold: 0 },
    clickhouseBonusCount: 6,
    clickhouseRefundCount: 2,
  },
  {
    userId: 9056385,
    prepaidsDiff: { bronze: 0, silver: -2, gold: 0 },
    clickhouseBonusCount: 7,
    clickhouseRefundCount: 0,
  },
  {
    userId: 3686512,
    prepaidsDiff: { bronze: -1, silver: 0, gold: 0 },
    clickhouseBonusCount: 5,
    clickhouseRefundCount: 0,
  },
  {
    userId: 9476097,
    prepaidsDiff: { bronze: -2, silver: 0, gold: 0 },
    clickhouseBonusCount: 5,
    clickhouseRefundCount: 0,
  },
  {
    userId: 3601985,
    prepaidsDiff: { bronze: -2, silver: 0, gold: 0 },
    clickhouseBonusCount: 5,
    clickhouseRefundCount: 0,
  },
  {
    userId: 2476492,
    prepaidsDiff: { bronze: -1, silver: 0, gold: 0 },
    clickhouseBonusCount: 3,
    clickhouseRefundCount: 0,
  },
  {
    userId: 4828749,
    prepaidsDiff: { bronze: -1, silver: 0, gold: 0 },
    clickhouseBonusCount: 7,
    clickhouseRefundCount: 0,
  },
  {
    userId: 7141613,
    prepaidsDiff: { bronze: -1, silver: 0, gold: 0 },
    clickhouseBonusCount: 5,
    clickhouseRefundCount: 0,
  },
  {
    userId: 8826587,
    prepaidsDiff: { bronze: -2, silver: 0, gold: 0 },
    clickhouseBonusCount: 6,
    clickhouseRefundCount: 2,
  },
  {
    userId: 27242,
    prepaidsDiff: { bronze: -2, silver: 0, gold: 0 },
    clickhouseBonusCount: 7,
    clickhouseRefundCount: 0,
  },
  {
    userId: 4665503,
    prepaidsDiff: { bronze: -2, silver: 0, gold: 0 },
    clickhouseBonusCount: 5,
    clickhouseRefundCount: 0,
  },
  {
    userId: 1097039,
    prepaidsDiff: { bronze: -1, silver: 0, gold: 0 },
    clickhouseBonusCount: 4,
    clickhouseRefundCount: 0,
  },
  {
    userId: 3983720,
    prepaidsDiff: { bronze: -2, silver: 0, gold: 0 },
    clickhouseBonusCount: 7,
    clickhouseRefundCount: 0,
  },
  {
    userId: 6565978,
    prepaidsDiff: { bronze: -1, silver: 0, gold: 0 },
    clickhouseBonusCount: 5,
    clickhouseRefundCount: 1,
  },
  {
    userId: 4290432,
    prepaidsDiff: { bronze: -2, silver: 0, gold: 0 },
    clickhouseBonusCount: 5,
    clickhouseRefundCount: 0,
  },
  {
    userId: 4269069,
    prepaidsDiff: { bronze: -2, silver: 0, gold: 0 },
    clickhouseBonusCount: 5,
    clickhouseRefundCount: 0,
  },
  {
    userId: 5785682,
    prepaidsDiff: { bronze: -2, silver: 0, gold: 0 },
    clickhouseBonusCount: 5,
    clickhouseRefundCount: 0,
  },
  {
    userId: 2543579,
    prepaidsDiff: { bronze: 0, silver: -2, gold: 0 },
    clickhouseBonusCount: 7,
    clickhouseRefundCount: 0,
  },
  {
    userId: 6553346,
    prepaidsDiff: { bronze: 0, silver: 0, gold: -2 },
    clickhouseBonusCount: 6,
    clickhouseRefundCount: 0,
  },
  {
    userId: 2822557,
    prepaidsDiff: { bronze: -2, silver: 0, gold: 0 },
    clickhouseBonusCount: 6,
    clickhouseRefundCount: 2,
  },
  {
    userId: 10311487,
    prepaidsDiff: { bronze: -1, silver: 0, gold: 0 },
    clickhouseBonusCount: 2,
    clickhouseRefundCount: 0,
  },
  {
    userId: 8630563,
    prepaidsDiff: { bronze: -1, silver: 0, gold: 0 },
    clickhouseBonusCount: 2,
    clickhouseRefundCount: 0,
  },
  {
    userId: 4176716,
    prepaidsDiff: { bronze: -1, silver: 0, gold: 0 },
    clickhouseBonusCount: 2,
    clickhouseRefundCount: 0,
  },
  {
    userId: 10353920,
    prepaidsDiff: { bronze: -1, silver: 0, gold: 0 },
    clickhouseBonusCount: 2,
    clickhouseRefundCount: 0,
  },
  {
    userId: 10353950,
    prepaidsDiff: { bronze: 0, silver: -1, gold: 0 },
    clickhouseBonusCount: 2,
    clickhouseRefundCount: 0,
  },
  {
    userId: 4870939,
    prepaidsDiff: { bronze: 0, silver: -1, gold: 0 },
    clickhouseBonusCount: 5,
    clickhouseRefundCount: 0,
  },
  {
    userId: 4770159,
    prepaidsDiff: { bronze: 0, silver: 0, gold: -1 },
    clickhouseBonusCount: 6,
    clickhouseRefundCount: 1,
  },
  {
    userId: 3661432,
    prepaidsDiff: { bronze: 0, silver: -1, gold: 0 },
    clickhouseBonusCount: 7,
    clickhouseRefundCount: 0,
  },
  {
    userId: 1780084,
    prepaidsDiff: { bronze: -1, silver: 0, gold: 0 },
    clickhouseBonusCount: 6,
    clickhouseRefundCount: 0,
  },
  {
    userId: 2763595,
    prepaidsDiff: { bronze: 0, silver: 0, gold: -2 },
    clickhouseBonusCount: 5,
    clickhouseRefundCount: 0,
  },
  {
    userId: 9211302,
    prepaidsDiff: { bronze: 0, silver: 0, gold: -1 },
    clickhouseBonusCount: 5,
    clickhouseRefundCount: 1,
  },
  {
    userId: 8795639,
    prepaidsDiff: { bronze: -1, silver: 0, gold: 0 },
    clickhouseBonusCount: 5,
    clickhouseRefundCount: 0,
  },
  {
    userId: 1356263,
    prepaidsDiff: { bronze: -1, silver: 0, gold: 0 },
    clickhouseBonusCount: 3,
    clickhouseRefundCount: 0,
  },
  {
    userId: 5936210,
    prepaidsDiff: { bronze: -1, silver: 0, gold: 0 },
    clickhouseBonusCount: 3,
    clickhouseRefundCount: 0,
  },
  {
    userId: 4696702,
    prepaidsDiff: { bronze: -1, silver: 0, gold: 0 },
    clickhouseBonusCount: 5,
    clickhouseRefundCount: 1,
  },
  {
    userId: 7401488,
    prepaidsDiff: { bronze: 0, silver: -1, gold: 0 },
    clickhouseBonusCount: 3,
    clickhouseRefundCount: 0,
  },
  {
    userId: 2978945,
    prepaidsDiff: { bronze: -1, silver: 0, gold: 0 },
    clickhouseBonusCount: 3,
    clickhouseRefundCount: 0,
  },
  {
    userId: 6180362,
    prepaidsDiff: { bronze: -1, silver: 0, gold: 0 },
    clickhouseBonusCount: 3,
    clickhouseRefundCount: 0,
  },
  {
    userId: 8822463,
    prepaidsDiff: { bronze: -1, silver: 0, gold: 0 },
    clickhouseBonusCount: 3,
    clickhouseRefundCount: 0,
  },
  {
    userId: 1636471,
    prepaidsDiff: { bronze: -1, silver: 0, gold: 0 },
    clickhouseBonusCount: 5,
    clickhouseRefundCount: 0,
  },
  {
    userId: 5503881,
    prepaidsDiff: { bronze: -1, silver: 0, gold: 0 },
    clickhouseBonusCount: 5,
    clickhouseRefundCount: 0,
  },
  {
    userId: 7700515,
    prepaidsDiff: { bronze: 0, silver: -1, gold: 0 },
    clickhouseBonusCount: 6,
    clickhouseRefundCount: 0,
  },
  {
    userId: 7122497,
    prepaidsDiff: { bronze: -1, silver: 0, gold: 0 },
    clickhouseBonusCount: 3,
    clickhouseRefundCount: 0,
  },
  {
    userId: 4643545,
    prepaidsDiff: { bronze: -1, silver: 0, gold: 0 },
    clickhouseBonusCount: 6,
    clickhouseRefundCount: 1,
  },
  {
    userId: 8077048,
    prepaidsDiff: { bronze: -1, silver: 0, gold: 0 },
    clickhouseBonusCount: 5,
    clickhouseRefundCount: 0,
  },
  {
    userId: 7032996,
    prepaidsDiff: { bronze: 0, silver: -2, gold: 0 },
    clickhouseBonusCount: 3,
    clickhouseRefundCount: 0,
  },
  {
    userId: 2889282,
    prepaidsDiff: { bronze: 0, silver: -1, gold: 0 },
    clickhouseBonusCount: 7,
    clickhouseRefundCount: 0,
  },
  {
    userId: 1754087,
    prepaidsDiff: { bronze: -1, silver: 0, gold: 0 },
    clickhouseBonusCount: 4,
    clickhouseRefundCount: 0,
  },
  {
    userId: 4799191,
    prepaidsDiff: { bronze: -1, silver: 0, gold: 0 },
    clickhouseBonusCount: 7,
    clickhouseRefundCount: 0,
  },
  {
    userId: 1154669,
    prepaidsDiff: { bronze: -1, silver: 0, gold: 0 },
    clickhouseBonusCount: 5,
    clickhouseRefundCount: 0,
  },
  {
    userId: 9832372,
    prepaidsDiff: { bronze: -1, silver: 0, gold: 0 },
    clickhouseBonusCount: 5,
    clickhouseRefundCount: 0,
  },
  {
    userId: 8994588,
    prepaidsDiff: { bronze: -1, silver: 0, gold: 0 },
    clickhouseBonusCount: 7,
    clickhouseRefundCount: 0,
  },
  {
    userId: 5934560,
    prepaidsDiff: { bronze: -1, silver: 0, gold: 0 },
    clickhouseBonusCount: 6,
    clickhouseRefundCount: 0,
  },
  {
    userId: 8227017,
    prepaidsDiff: { bronze: -2, silver: 0, gold: 0 },
    clickhouseBonusCount: 7,
    clickhouseRefundCount: 0,
  },
  {
    userId: 2021071,
    prepaidsDiff: { bronze: -2, silver: 0, gold: 0 },
    clickhouseBonusCount: 7,
    clickhouseRefundCount: 0,
  },
  {
    userId: 5091755,
    prepaidsDiff: { bronze: -1, silver: 0, gold: 0 },
    clickhouseBonusCount: 7,
    clickhouseRefundCount: 0,
  },
  {
    userId: 5465398,
    prepaidsDiff: { bronze: 0, silver: -1, gold: 0 },
    clickhouseBonusCount: 8,
    clickhouseRefundCount: 0,
  },
  {
    userId: 9611881,
    prepaidsDiff: { bronze: -1, silver: 0, gold: 0 },
    clickhouseBonusCount: 5,
    clickhouseRefundCount: 1,
  },
  {
    userId: 6449686,
    prepaidsDiff: { bronze: -1, silver: 0, gold: 0 },
    clickhouseBonusCount: 5,
    clickhouseRefundCount: 0,
  },
  {
    userId: 4255441,
    prepaidsDiff: { bronze: -1, silver: 0, gold: 0 },
    clickhouseBonusCount: 7,
    clickhouseRefundCount: 0,
  },
  {
    userId: 2772167,
    prepaidsDiff: { bronze: 0, silver: -1, gold: 0 },
    clickhouseBonusCount: 5,
    clickhouseRefundCount: 0,
  },
  {
    userId: 9899200,
    prepaidsDiff: { bronze: -1, silver: 0, gold: 0 },
    clickhouseBonusCount: 5,
    clickhouseRefundCount: 0,
  },
  {
    userId: 7411604,
    prepaidsDiff: { bronze: -1, silver: 0, gold: 0 },
    clickhouseBonusCount: 4,
    clickhouseRefundCount: 0,
  },
  {
    userId: 9279819,
    prepaidsDiff: { bronze: -1, silver: 0, gold: 0 },
    clickhouseBonusCount: 5,
    clickhouseRefundCount: 0,
  },
  {
    userId: 4023043,
    prepaidsDiff: { bronze: -1, silver: 0, gold: 0 },
    clickhouseBonusCount: 5,
    clickhouseRefundCount: 1,
  },
  {
    userId: 9593152,
    prepaidsDiff: { bronze: 0, silver: 0, gold: -1 },
    clickhouseBonusCount: 5,
    clickhouseRefundCount: 0,
  },
  {
    userId: 8860666,
    prepaidsDiff: { bronze: -1, silver: 0, gold: 0 },
    clickhouseBonusCount: 6,
    clickhouseRefundCount: 0,
  },
  {
    userId: 4884963,
    prepaidsDiff: { bronze: -1, silver: 0, gold: 0 },
    clickhouseBonusCount: 6,
    clickhouseRefundCount: 0,
  },
  {
    userId: 9946874,
    prepaidsDiff: { bronze: -1, silver: 0, gold: 0 },
    clickhouseBonusCount: 4,
    clickhouseRefundCount: 0,
  },
  {
    userId: 8556609,
    prepaidsDiff: { bronze: 0, silver: 0, gold: -2 },
    clickhouseBonusCount: 5,
    clickhouseRefundCount: 0,
  },
  {
    userId: 4201803,
    prepaidsDiff: { bronze: 0, silver: 0, gold: -1 },
    clickhouseBonusCount: 7,
    clickhouseRefundCount: 0,
  },
  {
    userId: 3119513,
    prepaidsDiff: { bronze: -1, silver: 0, gold: 0 },
    clickhouseBonusCount: 7,
    clickhouseRefundCount: 0,
  },
  {
    userId: 7229487,
    prepaidsDiff: { bronze: -1, silver: 0, gold: 0 },
    clickhouseBonusCount: 6,
    clickhouseRefundCount: 0,
  },
  {
    userId: 1413187,
    prepaidsDiff: { bronze: -1, silver: 0, gold: 0 },
    clickhouseBonusCount: 6,
    clickhouseRefundCount: 0,
  },
  {
    userId: 9629602,
    prepaidsDiff: { bronze: 0, silver: 0, gold: -2 },
    clickhouseBonusCount: 5,
    clickhouseRefundCount: 0,
  },
  {
    userId: 518233,
    prepaidsDiff: { bronze: 0, silver: -1, gold: 0 },
    clickhouseBonusCount: 6,
    clickhouseRefundCount: 1,
  },
  {
    userId: 9846793,
    prepaidsDiff: { bronze: -1, silver: 0, gold: 0 },
    clickhouseBonusCount: 5,
    clickhouseRefundCount: 0,
  },
  {
    userId: 4768633,
    prepaidsDiff: { bronze: 0, silver: -2, gold: 0 },
    clickhouseBonusCount: 3,
    clickhouseRefundCount: 0,
  },
  {
    userId: 2961220,
    prepaidsDiff: { bronze: -1, silver: 0, gold: 0 },
    clickhouseBonusCount: 7,
    clickhouseRefundCount: 0,
  },
  {
    userId: 73783,
    prepaidsDiff: { bronze: 0, silver: 0, gold: -1 },
    clickhouseBonusCount: 3,
    clickhouseRefundCount: 0,
  },
  {
    userId: 9817277,
    prepaidsDiff: { bronze: -1, silver: 0, gold: 0 },
    clickhouseBonusCount: 3,
    clickhouseRefundCount: 0,
  },
  {
    userId: 8936760,
    prepaidsDiff: { bronze: -1, silver: 0, gold: 0 },
    clickhouseBonusCount: 3,
    clickhouseRefundCount: 0,
  },
  {
    userId: 9149047,
    prepaidsDiff: { bronze: 0, silver: -1, gold: 0 },
    clickhouseBonusCount: 5,
    clickhouseRefundCount: 0,
  },
  {
    userId: 7349138,
    prepaidsDiff: { bronze: -2, silver: 0, gold: 0 },
    clickhouseBonusCount: 3,
    clickhouseRefundCount: 0,
  },
  {
    userId: 9923378,
    prepaidsDiff: { bronze: -2, silver: 0, gold: 0 },
    clickhouseBonusCount: 4,
    clickhouseRefundCount: 0,
  },
  {
    userId: 1677057,
    prepaidsDiff: { bronze: -1, silver: 0, gold: 0 },
    clickhouseBonusCount: 5,
    clickhouseRefundCount: 0,
  },
  {
    userId: 6095746,
    prepaidsDiff: { bronze: -1, silver: 0, gold: 0 },
    clickhouseBonusCount: 5,
    clickhouseRefundCount: 0,
  },
  {
    userId: 3396674,
    prepaidsDiff: { bronze: -2, silver: 0, gold: 0 },
    clickhouseBonusCount: 5,
    clickhouseRefundCount: 0,
  },
  {
    userId: 9562987,
    prepaidsDiff: { bronze: -1, silver: 0, gold: 0 },
    clickhouseBonusCount: 3,
    clickhouseRefundCount: 0,
  },
  {
    userId: 2958424,
    prepaidsDiff: { bronze: -1, silver: 0, gold: 0 },
    clickhouseBonusCount: 3,
    clickhouseRefundCount: 0,
  },
  {
    userId: 9552465,
    prepaidsDiff: { bronze: -2, silver: 0, gold: 0 },
    clickhouseBonusCount: 5,
    clickhouseRefundCount: 0,
  },
  {
    userId: 9897466,
    prepaidsDiff: { bronze: -1, silver: 0, gold: 0 },
    clickhouseBonusCount: 5,
    clickhouseRefundCount: 0,
  },
  {
    userId: 4690323,
    prepaidsDiff: { bronze: -1, silver: 0, gold: 0 },
    clickhouseBonusCount: 7,
    clickhouseRefundCount: 0,
  },
  {
    userId: 9121619,
    prepaidsDiff: { bronze: -1, silver: 0, gold: 0 },
    clickhouseBonusCount: 6,
    clickhouseRefundCount: 0,
  },
  {
    userId: 4645253,
    prepaidsDiff: { bronze: -1, silver: 0, gold: 0 },
    clickhouseBonusCount: 2,
    clickhouseRefundCount: 0,
  },
  {
    userId: 10348040,
    prepaidsDiff: { bronze: -1, silver: 0, gold: 0 },
    clickhouseBonusCount: 2,
    clickhouseRefundCount: 0,
  },
  {
    userId: 9641715,
    prepaidsDiff: { bronze: -2, silver: 0, gold: 0 },
    clickhouseBonusCount: 5,
    clickhouseRefundCount: 0,
  },
  {
    userId: 2761931,
    prepaidsDiff: { bronze: -2, silver: 0, gold: 0 },
    clickhouseBonusCount: 5,
    clickhouseRefundCount: 0,
  },
  {
    userId: 7741272,
    prepaidsDiff: { bronze: -2, silver: 0, gold: 0 },
    clickhouseBonusCount: 7,
    clickhouseRefundCount: 0,
  },
  {
    userId: 5398091,
    prepaidsDiff: { bronze: -1, silver: 0, gold: 0 },
    clickhouseBonusCount: 4,
    clickhouseRefundCount: 0,
  },
  {
    userId: 2025902,
    prepaidsDiff: { bronze: -1, silver: 0, gold: 0 },
    clickhouseBonusCount: 6,
    clickhouseRefundCount: 0,
  },
  {
    userId: 4994304,
    prepaidsDiff: { bronze: -2, silver: 0, gold: 0 },
    clickhouseBonusCount: 4,
    clickhouseRefundCount: 0,
  },
  {
    userId: 4883830,
    prepaidsDiff: { bronze: -1, silver: 0, gold: 0 },
    clickhouseBonusCount: 6,
    clickhouseRefundCount: 0,
  },
  {
    userId: 6957892,
    prepaidsDiff: { bronze: -2, silver: 0, gold: 0 },
    clickhouseBonusCount: 5,
    clickhouseRefundCount: 0,
  },
  {
    userId: 9102354,
    prepaidsDiff: { bronze: 0, silver: -1, gold: 0 },
    clickhouseBonusCount: 7,
    clickhouseRefundCount: 0,
  },
  {
    userId: 878985,
    prepaidsDiff: { bronze: -1, silver: 0, gold: 0 },
    clickhouseBonusCount: 5,
    clickhouseRefundCount: 0,
  },
  {
    userId: 6428916,
    prepaidsDiff: { bronze: -1, silver: 0, gold: 0 },
    clickhouseBonusCount: 8,
    clickhouseRefundCount: 0,
  },
  {
    userId: 6207267,
    prepaidsDiff: { bronze: -1, silver: 0, gold: 0 },
    clickhouseBonusCount: 6,
    clickhouseRefundCount: 0,
  },
  {
    userId: 2582572,
    prepaidsDiff: { bronze: -2, silver: 0, gold: 0 },
    clickhouseBonusCount: 7,
    clickhouseRefundCount: 0,
  },
  {
    userId: 2542417,
    prepaidsDiff: { bronze: 0, silver: -1, gold: 0 },
    clickhouseBonusCount: 5,
    clickhouseRefundCount: 0,
  },
  {
    userId: 4121823,
    prepaidsDiff: { bronze: 0, silver: -1, gold: 0 },
    clickhouseBonusCount: 5,
    clickhouseRefundCount: 1,
  },
  {
    userId: 7905376,
    prepaidsDiff: { bronze: -1, silver: 0, gold: 0 },
    clickhouseBonusCount: 3,
    clickhouseRefundCount: 0,
  },
  {
    userId: 1507589,
    prepaidsDiff: { bronze: 0, silver: -1, gold: 0 },
    clickhouseBonusCount: 7,
    clickhouseRefundCount: 0,
  },
  {
    userId: 9406383,
    prepaidsDiff: { bronze: 0, silver: -2, gold: 0 },
    clickhouseBonusCount: 5,
    clickhouseRefundCount: 0,
  },
  {
    userId: 2739784,
    prepaidsDiff: { bronze: 0, silver: -1, gold: 0 },
    clickhouseBonusCount: 6,
    clickhouseRefundCount: 0,
  },
  {
    userId: 9396203,
    prepaidsDiff: { bronze: -1, silver: 0, gold: 0 },
    clickhouseBonusCount: 4,
    clickhouseRefundCount: 0,
  },
  {
    userId: 9022788,
    prepaidsDiff: { bronze: -1, silver: 0, gold: 0 },
    clickhouseBonusCount: 5,
    clickhouseRefundCount: 0,
  },
  {
    userId: 9884995,
    prepaidsDiff: { bronze: 0, silver: -1, gold: 0 },
    clickhouseBonusCount: 4,
    clickhouseRefundCount: 0,
  },
  {
    userId: 4003012,
    prepaidsDiff: { bronze: 0, silver: -2, gold: 0 },
    clickhouseBonusCount: 7,
    clickhouseRefundCount: 0,
  },
  {
    userId: 6705596,
    prepaidsDiff: { bronze: -1, silver: 0, gold: 0 },
    clickhouseBonusCount: 6,
    clickhouseRefundCount: 1,
  },
  {
    userId: 2975027,
    prepaidsDiff: { bronze: 0, silver: -1, gold: 0 },
    clickhouseBonusCount: 5,
    clickhouseRefundCount: 0,
  },
  {
    userId: 7949642,
    prepaidsDiff: { bronze: -1, silver: -1, gold: 0 },
    clickhouseBonusCount: 4,
    clickhouseRefundCount: 0,
  },
  {
    userId: 2406374,
    prepaidsDiff: { bronze: 0, silver: -1, gold: 0 },
    clickhouseBonusCount: 5,
    clickhouseRefundCount: 0,
  },
  {
    userId: 9056211,
    prepaidsDiff: { bronze: 0, silver: -1, gold: 0 },
    clickhouseBonusCount: 5,
    clickhouseRefundCount: 0,
  },
  {
    userId: 700908,
    prepaidsDiff: { bronze: 0, silver: -1, gold: 0 },
    clickhouseBonusCount: 5,
    clickhouseRefundCount: 0,
  },
  {
    userId: 8562984,
    prepaidsDiff: { bronze: 0, silver: -1, gold: 0 },
    clickhouseBonusCount: 5,
    clickhouseRefundCount: 0,
  },
  {
    userId: 9611040,
    prepaidsDiff: { bronze: 0, silver: -1, gold: 0 },
    clickhouseBonusCount: 5,
    clickhouseRefundCount: 0,
  },
  {
    userId: 3415398,
    prepaidsDiff: { bronze: 0, silver: -1, gold: 0 },
    clickhouseBonusCount: 5,
    clickhouseRefundCount: 0,
  },
  {
    userId: 5897906,
    prepaidsDiff: { bronze: 0, silver: -1, gold: 0 },
    clickhouseBonusCount: 5,
    clickhouseRefundCount: 0,
  },
  {
    userId: 8969097,
    prepaidsDiff: { bronze: 0, silver: -1, gold: 0 },
    clickhouseBonusCount: 4,
    clickhouseRefundCount: 0,
  },
  {
    userId: 148019,
    prepaidsDiff: { bronze: -1, silver: -1, gold: 0 },
    clickhouseBonusCount: 6,
    clickhouseRefundCount: 0,
  },
  {
    userId: 6010972,
    prepaidsDiff: { bronze: -1, silver: -2, gold: 0 },
    clickhouseBonusCount: 8,
    clickhouseRefundCount: 0,
  },
  {
    userId: 3718431,
    prepaidsDiff: { bronze: 0, silver: -2, gold: 0 },
    clickhouseBonusCount: 6,
    clickhouseRefundCount: 0,
  },
  {
    userId: 5897893,
    prepaidsDiff: { bronze: 0, silver: -1, gold: 0 },
    clickhouseBonusCount: 5,
    clickhouseRefundCount: 0,
  },
  {
    userId: 7933724,
    prepaidsDiff: { bronze: 0, silver: -1, gold: 0 },
    clickhouseBonusCount: 8,
    clickhouseRefundCount: 0,
  },
  {
    userId: 1188736,
    prepaidsDiff: { bronze: 0, silver: -1, gold: 0 },
    clickhouseBonusCount: 5,
    clickhouseRefundCount: 0,
  },
  {
    userId: 3493061,
    prepaidsDiff: { bronze: 0, silver: -1, gold: 0 },
    clickhouseBonusCount: 7,
    clickhouseRefundCount: 0,
  },
  {
    userId: 10132642,
    prepaidsDiff: { bronze: 0, silver: -1, gold: 0 },
    clickhouseBonusCount: 4,
    clickhouseRefundCount: 0,
  },
  {
    userId: 6180091,
    prepaidsDiff: { bronze: 0, silver: -1, gold: 0 },
    clickhouseBonusCount: 5,
    clickhouseRefundCount: 0,
  },
  {
    userId: 10359633,
    prepaidsDiff: { bronze: -1, silver: -1, gold: 0 },
    clickhouseBonusCount: 3,
    clickhouseRefundCount: 0,
  },
  {
    userId: 8579907,
    prepaidsDiff: { bronze: 0, silver: -1, gold: 0 },
    clickhouseBonusCount: 4,
    clickhouseRefundCount: 0,
  },
  {
    userId: 1706267,
    prepaidsDiff: { bronze: -1, silver: -1, gold: 0 },
    clickhouseBonusCount: 5,
    clickhouseRefundCount: 0,
  },
  {
    userId: 3255652,
    prepaidsDiff: { bronze: -1, silver: -1, gold: 0 },
    clickhouseBonusCount: 4,
    clickhouseRefundCount: 0,
  },
  {
    userId: 7565347,
    prepaidsDiff: { bronze: -1, silver: -1, gold: 0 },
    clickhouseBonusCount: 4,
    clickhouseRefundCount: 0,
  },
  {
    userId: 9287012,
    prepaidsDiff: { bronze: 0, silver: -1, gold: 0 },
    clickhouseBonusCount: 5,
    clickhouseRefundCount: 0,
  },
  {
    userId: 7965202,
    prepaidsDiff: { bronze: 0, silver: -1, gold: 0 },
    clickhouseBonusCount: 5,
    clickhouseRefundCount: 0,
  },
  {
    userId: 9746520,
    prepaidsDiff: { bronze: 0, silver: -1, gold: 0 },
    clickhouseBonusCount: 4,
    clickhouseRefundCount: 0,
  },
  {
    userId: 10311065,
    prepaidsDiff: { bronze: 0, silver: -1, gold: 0 },
    clickhouseBonusCount: 3,
    clickhouseRefundCount: 0,
  },
  {
    userId: 6882765,
    prepaidsDiff: { bronze: 0, silver: -2, gold: 0 },
    clickhouseBonusCount: 6,
    clickhouseRefundCount: 0,
  },
  {
    userId: 9816304,
    prepaidsDiff: { bronze: 0, silver: -1, gold: 0 },
    clickhouseBonusCount: 5,
    clickhouseRefundCount: 0,
  },
  {
    userId: 9735990,
    prepaidsDiff: { bronze: -1, silver: -1, gold: 0 },
    clickhouseBonusCount: 3,
    clickhouseRefundCount: 0,
  },
  {
    userId: 3598911,
    prepaidsDiff: { bronze: 0, silver: -1, gold: 0 },
    clickhouseBonusCount: 6,
    clickhouseRefundCount: 2,
  },
  {
    userId: 1955563,
    prepaidsDiff: { bronze: 0, silver: -1, gold: 0 },
    clickhouseBonusCount: 6,
    clickhouseRefundCount: 0,
  },
  {
    userId: 9947069,
    prepaidsDiff: { bronze: 0, silver: -1, gold: 0 },
    clickhouseBonusCount: 4,
    clickhouseRefundCount: 0,
  },
  {
    userId: 6597314,
    prepaidsDiff: { bronze: 0, silver: -1, gold: 0 },
    clickhouseBonusCount: 6,
    clickhouseRefundCount: 0,
  },
  {
    userId: 1735452,
    prepaidsDiff: { bronze: -2, silver: -2, gold: 0 },
    clickhouseBonusCount: 7,
    clickhouseRefundCount: 0,
  },
  {
    userId: 5348961,
    prepaidsDiff: { bronze: -1, silver: -1, gold: 0 },
    clickhouseBonusCount: 3,
    clickhouseRefundCount: 0,
  },
  {
    userId: 10565062,
    prepaidsDiff: { bronze: -1, silver: -1, gold: 0 },
    clickhouseBonusCount: 3,
    clickhouseRefundCount: 0,
  },
  {
    userId: 5377291,
    prepaidsDiff: { bronze: -1, silver: 0, gold: 0 },
    clickhouseBonusCount: 7,
    clickhouseRefundCount: 1,
  },
  {
    userId: 10119621,
    prepaidsDiff: { bronze: -1, silver: 0, gold: 0 },
    clickhouseBonusCount: 2,
    clickhouseRefundCount: 0,
  },
  {
    userId: 10624270,
    prepaidsDiff: { bronze: 0, silver: -1, gold: 0 },
    clickhouseBonusCount: 2,
    clickhouseRefundCount: 0,
  },
  {
    userId: 10102605,
    prepaidsDiff: { bronze: -1, silver: 0, gold: 0 },
    clickhouseBonusCount: 4,
    clickhouseRefundCount: 0,
  },
  {
    userId: 7223337,
    prepaidsDiff: { bronze: 0, silver: -1, gold: 0 },
    clickhouseBonusCount: 5,
    clickhouseRefundCount: 0,
  },
  {
    userId: 192506,
    prepaidsDiff: { bronze: 0, silver: -1, gold: 0 },
    clickhouseBonusCount: 5,
    clickhouseRefundCount: 0,
  },
  {
    userId: 4621846,
    prepaidsDiff: { bronze: 0, silver: -2, gold: 0 },
    clickhouseBonusCount: 5,
    clickhouseRefundCount: 0,
  },
  {
    userId: 2835581,
    prepaidsDiff: { bronze: 0, silver: -1, gold: 0 },
    clickhouseBonusCount: 5,
    clickhouseRefundCount: 0,
  },
  {
    userId: 4224090,
    prepaidsDiff: { bronze: 0, silver: -2, gold: 0 },
    clickhouseBonusCount: 5,
    clickhouseRefundCount: 0,
  },
  {
    userId: 9698822,
    prepaidsDiff: { bronze: 0, silver: -1, gold: 0 },
    clickhouseBonusCount: 5,
    clickhouseRefundCount: 0,
  },
  {
    userId: 4608254,
    prepaidsDiff: { bronze: 0, silver: -1, gold: 0 },
    clickhouseBonusCount: 6,
    clickhouseRefundCount: 0,
  },
  {
    userId: 4428984,
    prepaidsDiff: { bronze: -1, silver: 0, gold: 0 },
    clickhouseBonusCount: 3,
    clickhouseRefundCount: 0,
  },
  {
    userId: 9380095,
    prepaidsDiff: { bronze: -1, silver: 0, gold: 0 },
    clickhouseBonusCount: 4,
    clickhouseRefundCount: 0,
  },
  {
    userId: 6579132,
    prepaidsDiff: { bronze: 0, silver: -1, gold: 0 },
    clickhouseBonusCount: 5,
    clickhouseRefundCount: 0,
  },
  {
    userId: 2090257,
    prepaidsDiff: { bronze: -1, silver: 0, gold: 0 },
    clickhouseBonusCount: 4,
    clickhouseRefundCount: 0,
  },
  {
    userId: 8572550,
    prepaidsDiff: { bronze: 0, silver: 0, gold: -2 },
    clickhouseBonusCount: 6,
    clickhouseRefundCount: 0,
  },
  {
    userId: 6515735,
    prepaidsDiff: { bronze: 0, silver: 0, gold: -1 },
    clickhouseBonusCount: 7,
    clickhouseRefundCount: 0,
  },
  {
    userId: 4970333,
    prepaidsDiff: { bronze: -1, silver: 0, gold: 0 },
    clickhouseBonusCount: 4,
    clickhouseRefundCount: 0,
  },
  {
    userId: 4185425,
    prepaidsDiff: { bronze: 0, silver: 0, gold: -1 },
    clickhouseBonusCount: 6,
    clickhouseRefundCount: 0,
  },
  {
    userId: 5659544,
    prepaidsDiff: { bronze: 0, silver: 0, gold: -1 },
    clickhouseBonusCount: 7,
    clickhouseRefundCount: 0,
  },
  {
    userId: 7004292,
    prepaidsDiff: { bronze: 0, silver: 0, gold: -1 },
    clickhouseBonusCount: 5,
    clickhouseRefundCount: 0,
  },
  {
    userId: 9882995,
    prepaidsDiff: { bronze: 0, silver: 0, gold: -1 },
    clickhouseBonusCount: 5,
    clickhouseRefundCount: 0,
  },
  {
    userId: 2388952,
    prepaidsDiff: { bronze: -1, silver: -1, gold: 0 },
    clickhouseBonusCount: 8,
    clickhouseRefundCount: 0,
  },
  {
    userId: 4823437,
    prepaidsDiff: { bronze: 0, silver: 0, gold: -1 },
    clickhouseBonusCount: 6,
    clickhouseRefundCount: 0,
  },
  {
    userId: 4123830,
    prepaidsDiff: { bronze: -1, silver: 0, gold: -1 },
    clickhouseBonusCount: 4,
    clickhouseRefundCount: 0,
  },
  {
    userId: 9615530,
    prepaidsDiff: { bronze: 0, silver: 0, gold: -1 },
    clickhouseBonusCount: 5,
    clickhouseRefundCount: 0,
  },
  {
    userId: 9643429,
    prepaidsDiff: { bronze: 0, silver: -1, gold: 0 },
    clickhouseBonusCount: 6,
    clickhouseRefundCount: 0,
  },
  {
    userId: 4243642,
    prepaidsDiff: { bronze: 0, silver: 0, gold: -1 },
    clickhouseBonusCount: 4,
    clickhouseRefundCount: 0,
  },
  {
    userId: 4870335,
    prepaidsDiff: { bronze: 0, silver: 0, gold: -1 },
    clickhouseBonusCount: 5,
    clickhouseRefundCount: 0,
  },
  {
    userId: 5065642,
    prepaidsDiff: { bronze: 0, silver: -1, gold: -1 },
    clickhouseBonusCount: 7,
    clickhouseRefundCount: 0,
  },
  {
    userId: 8600324,
    prepaidsDiff: { bronze: 0, silver: 0, gold: -1 },
    clickhouseBonusCount: 4,
    clickhouseRefundCount: 0,
  },
  {
    userId: 3325653,
    prepaidsDiff: { bronze: 0, silver: 0, gold: -1 },
    clickhouseBonusCount: 5,
    clickhouseRefundCount: 0,
  },
  {
    userId: 9834891,
    prepaidsDiff: { bronze: -1, silver: 0, gold: -2 },
    clickhouseBonusCount: 3,
    clickhouseRefundCount: 0,
  },
  {
    userId: 7909309,
    prepaidsDiff: { bronze: 0, silver: 0, gold: -1 },
    clickhouseBonusCount: 7,
    clickhouseRefundCount: 0,
  },
  {
    userId: 9027823,
    prepaidsDiff: { bronze: 0, silver: 0, gold: -1 },
    clickhouseBonusCount: 4,
    clickhouseRefundCount: 0,
  },
  {
    userId: 7113641,
    prepaidsDiff: { bronze: 0, silver: 0, gold: -1 },
    clickhouseBonusCount: 6,
    clickhouseRefundCount: 0,
  },
  {
    userId: 8574702,
    prepaidsDiff: { bronze: 0, silver: 0, gold: -1 },
    clickhouseBonusCount: 5,
    clickhouseRefundCount: 0,
  },
  {
    userId: 4324739,
    prepaidsDiff: { bronze: 0, silver: 0, gold: -1 },
    clickhouseBonusCount: 5,
    clickhouseRefundCount: 0,
  },
  {
    userId: 2137066,
    prepaidsDiff: { bronze: 0, silver: 0, gold: -1 },
    clickhouseBonusCount: 4,
    clickhouseRefundCount: 0,
  },
  {
    userId: 7713628,
    prepaidsDiff: { bronze: 0, silver: 0, gold: -1 },
    clickhouseBonusCount: 7,
    clickhouseRefundCount: 0,
  },
  {
    userId: 4731101,
    prepaidsDiff: { bronze: 0, silver: -1, gold: 0 },
    clickhouseBonusCount: 5,
    clickhouseRefundCount: 0,
  },
  {
    userId: 6958669,
    prepaidsDiff: { bronze: 0, silver: 0, gold: -1 },
    clickhouseBonusCount: 7,
    clickhouseRefundCount: 0,
  },
  {
    userId: 10039668,
    prepaidsDiff: { bronze: -1, silver: 0, gold: 0 },
    clickhouseBonusCount: 4,
    clickhouseRefundCount: 0,
  },
  {
    userId: 4035119,
    prepaidsDiff: { bronze: 0, silver: 0, gold: -2 },
    clickhouseBonusCount: 8,
    clickhouseRefundCount: 0,
  },
  {
    userId: 9141211,
    prepaidsDiff: { bronze: -1, silver: 0, gold: 0 },
    clickhouseBonusCount: 5,
    clickhouseRefundCount: 1,
  },
  {
    userId: 3552386,
    prepaidsDiff: { bronze: 0, silver: 0, gold: -2 },
    clickhouseBonusCount: 7,
    clickhouseRefundCount: 0,
  },
  {
    userId: 3305150,
    prepaidsDiff: { bronze: 0, silver: -1, gold: -1 },
    clickhouseBonusCount: 4,
    clickhouseRefundCount: 0,
  },
  {
    userId: 9458836,
    prepaidsDiff: { bronze: 0, silver: 0, gold: -1 },
    clickhouseBonusCount: 5,
    clickhouseRefundCount: 0,
  },
  {
    userId: 4657039,
    prepaidsDiff: { bronze: 0, silver: -1, gold: 0 },
    clickhouseBonusCount: 6,
    clickhouseRefundCount: 1,
  },
  {
    userId: 9673274,
    prepaidsDiff: { bronze: 0, silver: -1, gold: 0 },
    clickhouseBonusCount: 6,
    clickhouseRefundCount: 0,
  },
  {
    userId: 1492313,
    prepaidsDiff: { bronze: -1, silver: 0, gold: -1 },
    clickhouseBonusCount: 4,
    clickhouseRefundCount: 0,
  },
  {
    userId: 2941459,
    prepaidsDiff: { bronze: 0, silver: 0, gold: -1 },
    clickhouseBonusCount: 7,
    clickhouseRefundCount: 0,
  },
  {
    userId: 9735892,
    prepaidsDiff: { bronze: 0, silver: -1, gold: 0 },
    clickhouseBonusCount: 6,
    clickhouseRefundCount: 0,
  },
  {
    userId: 5870924,
    prepaidsDiff: { bronze: 0, silver: -1, gold: 0 },
    clickhouseBonusCount: 6,
    clickhouseRefundCount: 0,
  },
  {
    userId: 7063067,
    prepaidsDiff: { bronze: -1, silver: 0, gold: 0 },
    clickhouseBonusCount: 2,
    clickhouseRefundCount: 0,
  },
  {
    userId: 6711076,
    prepaidsDiff: { bronze: -1, silver: 0, gold: 0 },
    clickhouseBonusCount: 2,
    clickhouseRefundCount: 0,
  },
  {
    userId: 10290145,
    prepaidsDiff: { bronze: -1, silver: 0, gold: 0 },
    clickhouseBonusCount: 3,
    clickhouseRefundCount: 0,
  },
  {
    userId: 2800934,
    prepaidsDiff: { bronze: -1, silver: 0, gold: 0 },
    clickhouseBonusCount: 2,
    clickhouseRefundCount: 0,
  },
  {
    userId: 10621551,
    prepaidsDiff: { bronze: -1, silver: 0, gold: 0 },
    clickhouseBonusCount: 2,
    clickhouseRefundCount: 0,
  },
  {
    userId: 6519468,
    prepaidsDiff: { bronze: -1, silver: 0, gold: 0 },
    clickhouseBonusCount: 2,
    clickhouseRefundCount: 0,
  },
  {
    userId: 5005706,
    prepaidsDiff: { bronze: -1, silver: 0, gold: 0 },
    clickhouseBonusCount: 2,
    clickhouseRefundCount: 0,
  },
  {
    userId: 5027467,
    prepaidsDiff: { bronze: -1, silver: 0, gold: 0 },
    clickhouseBonusCount: 5,
    clickhouseRefundCount: 0,
  },
  {
    userId: 7723279,
    prepaidsDiff: { bronze: -1, silver: 0, gold: 0 },
    clickhouseBonusCount: 6,
    clickhouseRefundCount: 2,
  },
  {
    userId: 236490,
    prepaidsDiff: { bronze: -1, silver: 0, gold: 0 },
    clickhouseBonusCount: 5,
    clickhouseRefundCount: 0,
  },
  {
    userId: 8578763,
    prepaidsDiff: { bronze: -1, silver: 0, gold: 0 },
    clickhouseBonusCount: 8,
    clickhouseRefundCount: 1,
  },
  {
    userId: 10069851,
    prepaidsDiff: { bronze: -1, silver: 0, gold: 0 },
    clickhouseBonusCount: 4,
    clickhouseRefundCount: 0,
  },
  {
    userId: 2711088,
    prepaidsDiff: { bronze: 0, silver: -2, gold: 0 },
    clickhouseBonusCount: 7,
    clickhouseRefundCount: 0,
  },
  {
    userId: 2388882,
    prepaidsDiff: { bronze: 0, silver: 0, gold: -1 },
    clickhouseBonusCount: 5,
    clickhouseRefundCount: 0,
  },
  {
    userId: 10085108,
    prepaidsDiff: { bronze: -1, silver: 0, gold: 0 },
    clickhouseBonusCount: 5,
    clickhouseRefundCount: 0,
  },
  {
    userId: 10119775,
    prepaidsDiff: { bronze: -1, silver: 0, gold: 0 },
    clickhouseBonusCount: 4,
    clickhouseRefundCount: 0,
  },
  {
    userId: 6318612,
    prepaidsDiff: { bronze: -2, silver: 0, gold: 0 },
    clickhouseBonusCount: 5,
    clickhouseRefundCount: 0,
  },
  {
    userId: 6890511,
    prepaidsDiff: { bronze: -1, silver: 0, gold: 0 },
    clickhouseBonusCount: 4,
    clickhouseRefundCount: 0,
  },
  {
    userId: 3512422,
    prepaidsDiff: { bronze: 0, silver: -1, gold: 0 },
    clickhouseBonusCount: 5,
    clickhouseRefundCount: 0,
  },
  {
    userId: 9601276,
    prepaidsDiff: { bronze: 0, silver: -2, gold: 0 },
    clickhouseBonusCount: 6,
    clickhouseRefundCount: 0,
  },
  {
    userId: 8381066,
    prepaidsDiff: { bronze: -2, silver: 0, gold: 0 },
    clickhouseBonusCount: 5,
    clickhouseRefundCount: 0,
  },
  {
    userId: 9820214,
    prepaidsDiff: { bronze: -2, silver: 0, gold: 0 },
    clickhouseBonusCount: 6,
    clickhouseRefundCount: 0,
  },
  {
    userId: 3721329,
    prepaidsDiff: { bronze: -1, silver: 0, gold: 0 },
    clickhouseBonusCount: 5,
    clickhouseRefundCount: 0,
  },
  {
    userId: 3884343,
    prepaidsDiff: { bronze: -1, silver: 0, gold: 0 },
    clickhouseBonusCount: 5,
    clickhouseRefundCount: 0,
  },
  {
    userId: 3488893,
    prepaidsDiff: { bronze: -1, silver: 0, gold: 0 },
    clickhouseBonusCount: 6,
    clickhouseRefundCount: 1,
  },
  {
    userId: 4698429,
    prepaidsDiff: { bronze: -1, silver: 0, gold: 0 },
    clickhouseBonusCount: 6,
    clickhouseRefundCount: 0,
  },
];

const LOOKBACK_DATE = dayjs().subtract(6, 'month').startOf('month');

type BuzzApiTransaction = {
  date: string;
  amount: number;
  description: string | null;
};

async function queryBuzzApiForUser(userId: number): Promise<{
  bonusTransactions: BuzzApiTransaction[];
  refundTransactions: BuzzApiTransaction[];
}> {
  const bonusTransactions: BuzzApiTransaction[] = [];
  const refundTransactions: BuzzApiTransaction[] = [];

  let cursor: Date | undefined;
  let hasMore = true;
  let iterations = 0;
  const maxIterations = 20; // Safety limit

  while (hasMore && iterations < maxIterations) {
    iterations++;

    const result = await getUserBuzzTransactions({
      accountId: userId,
      limit: 200,
      cursor,
      start: LOOKBACK_DATE.toDate(),
    });

    for (const tx of result.transactions) {
      const desc = tx.description?.toLowerCase() ?? '';

      // Check for membership bonus transactions
      if (tx.toAccountId === userId && desc.includes('membership') && desc.includes('bonus')) {
        bonusTransactions.push({
          date: dayjs(tx.date).format('YYYY-MM-DD HH:mm:ss'),
          amount: tx.amount,
          description: tx.description,
        });
      }

      // Check for refund transactions
      if (
        tx.fromAccountId === userId &&
        desc.includes('free membership renewal error correction reclaim')
      ) {
        refundTransactions.push({
          date: dayjs(tx.date).format('YYYY-MM-DD HH:mm:ss'),
          amount: Math.abs(tx.amount),
          description: tx.description,
        });
      }
    }

    cursor = result.cursor ?? undefined;
    hasMore = !!cursor && result.transactions.length > 0;
  }

  return { bonusTransactions, refundTransactions };
}

export default WebhookEndpoint(async (req, res: NextApiResponse) => {
  const offset = parseInt(req.query.offset as string) || 0;
  const limit = Math.min(parseInt(req.query.limit as string) || 50, 100);

  console.log(`[query-buzz-api] Starting with offset=${offset}, limit=${limit}`);
  console.log(`[query-buzz-api] Total users: ${USERS_NEEDING_ADD.length}`);

  if (USERS_NEEDING_ADD.length === 0) {
    return res.status(200).json({
      success: true,
      message: 'No users configured. Please populate USERS_NEEDING_ADD array.',
      summary: { total: 0 },
    });
  }

  const usersToProcess = USERS_NEEDING_ADD.slice(offset, offset + limit);
  console.log(`[query-buzz-api] Processing ${usersToProcess.length} users`);

  const results: Array<{
    userId: number;
    prepaidsDiff: { bronze: number; silver: number; gold: number };
    clickhouse: { bonusCount: number; refundCount: number };
    buzzApi: {
      bonusCount: number;
      refundCount: number;
      bonusTransactions: BuzzApiTransaction[];
      refundTransactions: BuzzApiTransaction[];
    };
    analysis: {
      bonusCountDiff: number;
      refundCountDiff: number;
      missingFromClickhouse: boolean;
    };
  }> = [];

  const errors: Array<{ userId: number; error: string }> = [];

  for (let i = 0; i < usersToProcess.length; i++) {
    const user = usersToProcess[i];

    if (i % 10 === 0) {
      console.log(`[query-buzz-api] Progress: ${i}/${usersToProcess.length}`);
    }

    try {
      const buzzApiData = await queryBuzzApiForUser(user.userId);

      const bonusCountDiff = buzzApiData.bonusTransactions.length - user.clickhouseBonusCount;
      const refundCountDiff = buzzApiData.refundTransactions.length - user.clickhouseRefundCount;

      results.push({
        userId: user.userId,
        prepaidsDiff: user.prepaidsDiff,
        clickhouse: {
          bonusCount: user.clickhouseBonusCount,
          refundCount: user.clickhouseRefundCount,
        },
        buzzApi: {
          bonusCount: buzzApiData.bonusTransactions.length,
          refundCount: buzzApiData.refundTransactions.length,
          bonusTransactions: buzzApiData.bonusTransactions,
          refundTransactions: buzzApiData.refundTransactions,
        },
        analysis: {
          bonusCountDiff,
          refundCountDiff,
          missingFromClickhouse: bonusCountDiff > 0 || refundCountDiff > 0,
        },
      });
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      console.error(`[query-buzz-api] Error for user ${user.userId}: ${msg}`);
      errors.push({ userId: user.userId, error: msg });
    }
  }

  const summary = {
    total: USERS_NEEDING_ADD.length,
    offset,
    limit,
    processed: usersToProcess.length,
    successful: results.length,
    errors: errors.length,
    hasMore: offset + limit < USERS_NEEDING_ADD.length,
    nextOffset: offset + limit,
    // Analysis
    exactMatch: results.filter(
      (r) => r.analysis.bonusCountDiff === 0 && r.analysis.refundCountDiff === 0
    ).length,
    moreInBuzzApi: results.filter((r) => r.analysis.bonusCountDiff > 0).length,
    lessInBuzzApi: results.filter((r) => r.analysis.bonusCountDiff < 0).length,
    missingFromClickhouse: results.filter((r) => r.analysis.missingFromClickhouse).length,
  };

  console.log(`[query-buzz-api] Complete`);
  console.log(`  Successful: ${summary.successful}`);
  console.log(`  Errors: ${summary.errors}`);
  console.log(`  Exact match: ${summary.exactMatch}`);
  console.log(`  More in Buzz API: ${summary.moreInBuzzApi}`);
  console.log(`  Less in Buzz API: ${summary.lessInBuzzApi}`);

  return res.status(200).json({
    success: true,
    generatedAt: new Date().toISOString(),
    lookbackDate: LOOKBACK_DATE.format('YYYY-MM-DD'),
    summary,
    results,
    errors,
  });
});
