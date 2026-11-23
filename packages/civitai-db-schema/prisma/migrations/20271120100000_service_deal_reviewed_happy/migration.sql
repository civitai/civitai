-- M3a. Applied by hand only after a web release carrying the client that knows the value
-- (civitai/civitai#9819, 0e12f2f9) is live. Nothing writes the value until the P3 PR merges.
ALTER TYPE "ServiceDealEventType" ADD VALUE IF NOT EXISTS 'ReviewedHappy';
