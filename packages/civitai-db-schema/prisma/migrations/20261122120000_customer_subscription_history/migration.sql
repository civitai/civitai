-- "CustomerSubscription" holds one row per (userId, buzzType) slot and only its current state:
-- a new Stripe subscription overwrites the old id in place, a cancel or a redeemed code deletes
-- the row, and a repeat Buzz purchase reuses it for a new month. "CustomerSubscriptionHistory"
-- keeps one row per membership instead, so the user's billing page can show what they had.
--
-- A trigger maintains it, because "CustomerSubscription" is written from dozens of places
-- (webhooks, jobs, raw SQL); no single application path sees every change.
--
-- Each slot has at most one open history row ("closedAt" IS NULL), which mirrors the live row.
-- A history row is closed, and a new one opened, when the live row:
--   * is deleted                                  -> closedReason 'removed'
--   * gets a different subscription id            -> closedReason 'replaced'
--   * changes product (tier or plan)              -> closedReason 'plan-changed'
--   * restarts after ending, or after a gap        -> closedReason 'restarted'
-- Otherwise the open row is updated in place (renewals, cancels, status changes, token claims).

CREATE TABLE "CustomerSubscriptionHistory" (
  "id" SERIAL PRIMARY KEY,
  -- No foreign key to "User": adding one locks "User" while it validates.
  "userId" INTEGER NOT NULL,
  "subscriptionId" TEXT NOT NULL,
  "buzzType" TEXT NOT NULL,
  -- No foreign keys on product/price: history must not block retiring an old product.
  "productId" TEXT NOT NULL,
  "priceId" TEXT NOT NULL,
  "status" TEXT NOT NULL,
  "metadata" JSONB NOT NULL DEFAULT '{}',
  "cancelAtPeriodEnd" BOOLEAN NOT NULL DEFAULT false,
  "cancelAt" TIMESTAMP(3),
  "canceledAt" TIMESTAMP(3),
  "startedAt" TIMESTAMP(3) NOT NULL,
  "currentPeriodStart" TIMESTAMP(3) NOT NULL,
  "currentPeriodEnd" TIMESTAMP(3) NOT NULL,
  "endedAt" TIMESTAMP(3),
  "closedAt" TIMESTAMP(3),
  "closedReason" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX "CustomerSubscriptionHistory_userId_idx" ON "CustomerSubscriptionHistory" ("userId");
CREATE UNIQUE INDEX "CustomerSubscriptionHistory_open_slot_key"
  ON "CustomerSubscriptionHistory" ("userId", "buzzType")
  WHERE "closedAt" IS NULL;

-- Writes the live row into its slot's open history row, creating one if the slot has none.
CREATE OR REPLACE FUNCTION customer_subscription_history_upsert_open(
  sub "CustomerSubscription",
  started_at TIMESTAMP(3)
) RETURNS void AS $$
BEGIN
  INSERT INTO "CustomerSubscriptionHistory" (
    "userId", "subscriptionId", "buzzType", "productId", "priceId", "status", "metadata",
    "cancelAtPeriodEnd", "cancelAt", "canceledAt", "startedAt", "currentPeriodStart",
    "currentPeriodEnd", "endedAt"
  ) VALUES (
    sub."userId", sub."id", sub."buzzType", sub."productId", sub."priceId", sub."status",
    COALESCE(sub."metadata", '{}'::jsonb), sub."cancelAtPeriodEnd", sub."cancelAt",
    sub."canceledAt", started_at, sub."currentPeriodStart", sub."currentPeriodEnd", sub."endedAt"
  )
  ON CONFLICT ("userId", "buzzType") WHERE "closedAt" IS NULL DO UPDATE SET
    "subscriptionId" = EXCLUDED."subscriptionId",
    "productId" = EXCLUDED."productId",
    "priceId" = EXCLUDED."priceId",
    "status" = EXCLUDED."status",
    "metadata" = EXCLUDED."metadata",
    "cancelAtPeriodEnd" = EXCLUDED."cancelAtPeriodEnd",
    "cancelAt" = EXCLUDED."cancelAt",
    "canceledAt" = EXCLUDED."canceledAt",
    "currentPeriodStart" = EXCLUDED."currentPeriodStart",
    "currentPeriodEnd" = EXCLUDED."currentPeriodEnd",
    "endedAt" = EXCLUDED."endedAt",
    "updatedAt" = CURRENT_TIMESTAMP;
END;
$$ LANGUAGE plpgsql;

-- Closes the slot's open history row, which mirrors the live row's last state. A row closed while
-- still running ends now, or at its period end if that already passed (a lapsed row the expiry
-- job had not flipped yet).
CREATE OR REPLACE FUNCTION customer_subscription_history_close(
  user_id INTEGER,
  buzz_type TEXT,
  reason TEXT
) RETURNS void AS $$
BEGIN
  UPDATE "CustomerSubscriptionHistory" h SET
    "status" = CASE
      WHEN h."status" IN ('canceled', 'incomplete_expired') THEN h."status"
      ELSE 'canceled'
    END,
    "endedAt" = COALESCE(
      h."endedAt",
      CASE
        WHEN h."status" IN ('canceled', 'incomplete_expired')
          THEN COALESCE(h."canceledAt", h."currentPeriodEnd")
        ELSE LEAST(CURRENT_TIMESTAMP::timestamp(3), h."currentPeriodEnd")
      END
    ),
    "closedAt" = CURRENT_TIMESTAMP,
    "closedReason" = reason,
    "updatedAt" = CURRENT_TIMESTAMP
  WHERE h."userId" = user_id AND h."buzzType" = buzz_type AND h."closedAt" IS NULL;
END;
$$ LANGUAGE plpgsql;

-- History must never block a billing write: on any error the change is still committed, a
-- warning is logged, and customer_subscription_history_reconcile() repairs the history later.
CREATE OR REPLACE FUNCTION customer_subscription_history_sync() RETURNS trigger AS $$
DECLARE
  reason TEXT;
BEGIN
  BEGIN
    IF TG_OP = 'DELETE' THEN
      PERFORM customer_subscription_history_close(OLD."userId", OLD."buzzType", 'removed');
    ELSIF TG_OP = 'INSERT' THEN
      -- A slot only has an open row here if a delete happened while the trigger was off.
      PERFORM customer_subscription_history_close(NEW."userId", NEW."buzzType", 'replaced');
      PERFORM customer_subscription_history_upsert_open(NEW, NEW."createdAt");
    ELSIF NEW."userId" <> OLD."userId" OR NEW."buzzType" <> OLD."buzzType" THEN
      PERFORM customer_subscription_history_close(OLD."userId", OLD."buzzType", 'replaced');
      PERFORM customer_subscription_history_close(NEW."userId", NEW."buzzType", 'replaced');
      PERFORM customer_subscription_history_upsert_open(NEW, NEW."createdAt");
    ELSE
      reason := CASE
        WHEN NEW."id" <> OLD."id" THEN 'replaced'
        WHEN NEW."productId" <> OLD."productId" THEN 'plan-changed'
        WHEN OLD."status" IN ('canceled', 'incomplete_expired')
          AND NEW."status" NOT IN ('canceled', 'incomplete_expired') THEN 'restarted'
        -- A renewal starts exactly where the last period ended; a later start is a new purchase.
        WHEN NEW."currentPeriodStart" > OLD."currentPeriodEnd" THEN 'restarted'
        ELSE NULL
      END;

      IF reason IS NOT NULL THEN
        PERFORM customer_subscription_history_close(OLD."userId", OLD."buzzType", reason);
      END IF;
      PERFORM customer_subscription_history_upsert_open(
        NEW,
        CASE
          WHEN reason IS NULL OR NEW."id" <> OLD."id" THEN NEW."createdAt"
          -- An upgrade or downgrade usually keeps the running period, so it starts now.
          WHEN reason = 'plan-changed'
            THEN GREATEST(NEW."currentPeriodStart", CURRENT_TIMESTAMP::timestamp(3))
          ELSE NEW."currentPeriodStart"
        END
      );
    END IF;
  EXCEPTION WHEN OTHERS THEN
    RAISE WARNING 'CustomerSubscriptionHistory sync failed (%): %', TG_OP, SQLERRM;
  END;

  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER customer_subscription_history_sync
AFTER INSERT OR UPDATE OR DELETE ON "CustomerSubscription"
FOR EACH ROW EXECUTE FUNCTION customer_subscription_history_sync();

-- Brings the history in line with "CustomerSubscription" after anything that bypassed the
-- trigger (it was disabled, or writes ran with session_replication_role = replica):
-- every live row gets its open history row refreshed, and every open history row whose slot
-- has no live row is closed. Returns how many rows each step touched. Safe to run repeatedly;
-- the reconcile-subscription-history job calls it daily.
CREATE OR REPLACE FUNCTION customer_subscription_history_reconcile(
  OUT refreshed INTEGER,
  OUT closed INTEGER
) AS $$
DECLARE
  sub "CustomerSubscription";
  orphan RECORD;
BEGIN
  refreshed := 0;
  FOR sub IN
    SELECT cs.* FROM "CustomerSubscription" cs
    LEFT JOIN "CustomerSubscriptionHistory" h
      ON h."userId" = cs."userId" AND h."buzzType" = cs."buzzType" AND h."closedAt" IS NULL
    WHERE h."id" IS NULL
      OR h."subscriptionId" <> cs."id"
      OR h."productId" <> cs."productId"
      OR h."priceId" <> cs."priceId"
      OR h."status" <> cs."status"
      OR h."metadata" IS DISTINCT FROM COALESCE(cs."metadata", '{}'::jsonb)
      OR h."cancelAtPeriodEnd" <> cs."cancelAtPeriodEnd"
      OR h."cancelAt" IS DISTINCT FROM cs."cancelAt"
      OR h."canceledAt" IS DISTINCT FROM cs."canceledAt"
      OR h."currentPeriodStart" <> cs."currentPeriodStart"
      OR h."currentPeriodEnd" <> cs."currentPeriodEnd"
      OR h."endedAt" IS DISTINCT FROM cs."endedAt"
  LOOP
    -- A different subscription or product in the slot is a new membership, as in the trigger.
    IF EXISTS (
      SELECT 1 FROM "CustomerSubscriptionHistory" h
      WHERE h."userId" = sub."userId" AND h."buzzType" = sub."buzzType" AND h."closedAt" IS NULL
        AND (h."subscriptionId" <> sub."id" OR h."productId" <> sub."productId")
    ) THEN
      PERFORM customer_subscription_history_close(sub."userId", sub."buzzType", 'replaced');
    END IF;
    PERFORM customer_subscription_history_upsert_open(sub, sub."createdAt");
    refreshed := refreshed + 1;
  END LOOP;

  closed := 0;
  FOR orphan IN
    SELECT h."userId", h."buzzType" FROM "CustomerSubscriptionHistory" h
    WHERE h."closedAt" IS NULL
      AND NOT EXISTS (
        SELECT 1 FROM "CustomerSubscription" cs
        WHERE cs."userId" = h."userId" AND cs."buzzType" = h."buzzType"
      )
  LOOP
    PERFORM customer_subscription_history_close(orphan."userId", orphan."buzzType", 'removed');
    closed := closed + 1;
  END LOOP;
END;
$$ LANGUAGE plpgsql;

-- Backfill: one open history row per existing subscription. Memberships that ended and were
-- deleted or overwritten before this migration are not recoverable from this table.
SELECT * FROM customer_subscription_history_reconcile();
