-- AlterEnum
-- A sticker report needs its own reason, not TOSViolation, because reports dedupe
-- on (reason, entityId): riding on TOSViolation folds every sticker report into
-- whatever TOS report the image already had and discards its details, including
-- the placement id the report exists to carry.
ALTER TYPE "ReportReason" ADD VALUE IF NOT EXISTS 'StickerPlacement';
