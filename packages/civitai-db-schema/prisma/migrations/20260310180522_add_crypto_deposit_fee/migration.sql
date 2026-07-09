-- Stores webhook-only fee data from NowPayments deposits.
-- The GET /payment/{id} endpoint does not return fee breakdowns or fiat equivalents,
-- so we capture them from the IPN webhook on finished status.
CREATE TABLE "CryptoDepositFee" (
    "paymentId" BIGINT NOT NULL,
    "depositFee" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "serviceFee" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "feeCurrency" TEXT NOT NULL DEFAULT 'usdcbase',
    "paidFiat" DOUBLE PRECISION,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CryptoDepositFee_pkey" PRIMARY KEY ("paymentId")
);
