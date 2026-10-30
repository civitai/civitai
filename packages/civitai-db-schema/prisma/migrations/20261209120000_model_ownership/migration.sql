-- Every owner a model has had, including its first, so a hold on an earlier owner still covers the
-- model's data after it moves. Append-only. No foreign keys: a row must outlive its model and user.
--
-- Apply this, then backfill.sql, BEFORE deploying the code that writes it: model create, transfer,
-- account deletion and restore insert here in the same transaction as the owner write, and fail
-- without the table.

CREATE TABLE "ModelOwnership" (
  "id" SERIAL PRIMARY KEY,
  "modelId" INTEGER NOT NULL,
  "userId" INTEGER NOT NULL,
  "reason" TEXT NOT NULL
    CHECK ("reason" IN ('create', 'transfer', 'account-delete', 'restore', 'baseline')),
  "actorId" INTEGER,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX "ModelOwnership_modelId_idx" ON "ModelOwnership" ("modelId");
CREATE INDEX "ModelOwnership_userId_idx" ON "ModelOwnership" ("userId");

CREATE OR REPLACE FUNCTION model_ownership_refuse_change() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'ModelOwnership is append-only';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "ModelOwnership_append_only"
  BEFORE UPDATE OR DELETE ON "ModelOwnership"
  FOR EACH ROW EXECUTE FUNCTION model_ownership_refuse_change();

CREATE TRIGGER "ModelOwnership_refuse_truncate"
  BEFORE TRUNCATE ON "ModelOwnership"
  FOR EACH STATEMENT EXECUTE FUNCTION model_ownership_refuse_change();
