-- AlterTable: Add chain and payCurrency columns with defaults
ALTER TABLE "CryptoWallet" ADD COLUMN "chain" TEXT NOT NULL DEFAULT 'evm';
ALTER TABLE "CryptoWallet" ADD COLUMN "payCurrency" TEXT NOT NULL DEFAULT 'usdcbase';

-- Change PK from userId to (userId, chain)
ALTER TABLE "CryptoWallet" DROP CONSTRAINT "CryptoWallet_pkey";
ALTER TABLE "CryptoWallet" ADD CONSTRAINT "CryptoWallet_pkey" PRIMARY KEY ("userId", "chain");
