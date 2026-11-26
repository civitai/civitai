-- A service's request form: questions whose answers add to its base price and delivery days.
-- "requestForm" is null for a service without one, which keeps its single price. "fromPrice" is the
-- cheapest total a valid set of answers gives, written with the form, and is what cards, search and
-- price sorting read; null when there is no form. Each saved edit bumps "requestFormVersion".
ALTER TABLE "ServiceOffering"
  ADD COLUMN "requestForm" JSONB,
  ADD COLUMN "requestFormVersion" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "fromPrice" INTEGER;

-- A deal requested through a form keeps the version it was priced from, the buyer's answers and the
-- line-by-line breakdown of its price. All null for a deal requested without one.
ALTER TABLE "ServiceDeal"
  ADD COLUMN "formVersion" INTEGER,
  ADD COLUMN "formAnswers" JSONB,
  ADD COLUMN "priceBreakdown" JSONB;
