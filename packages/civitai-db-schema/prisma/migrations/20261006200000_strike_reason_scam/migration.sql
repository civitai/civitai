-- Apply before the deploy that issues Scam strikes: no row uses the value until that code runs.
ALTER TYPE "StrikeReason" ADD VALUE IF NOT EXISTS 'Scam';
