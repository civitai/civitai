-- Agent review, connect lane: the facts Civitai checks itself for a connect-listing report, kept
-- apart from the report's runner-written sections so the runner has no way to write or imitate
-- them, plus a fingerprint of the listing fields the review read (stale detection).
--
-- New table only; nothing existing changes. HAND-APPLIED, before the `app-listings-agentic-review`
-- flag is turned on. Until it is applied, a connect review refuses to start (the row write fails
-- and the report is marked failed); on-site reviews never touch it.
--
-- After applying, inside a transaction you roll back:
--   BEGIN;
--   SELECT count(*) FROM app_review_agent_report_checks;  -- expect 0
--   ROLLBACK;
--
-- To revert: DROP TABLE app_review_agent_report_checks;

BEGIN;
SET LOCAL lock_timeout = '3s';

CREATE TABLE IF NOT EXISTS app_review_agent_report_checks (
  report_id          text        PRIMARY KEY
                                 REFERENCES app_review_agent_reports (id) ON DELETE CASCADE,
  publish_request_id text        NOT NULL,
  checks             jsonb       NOT NULL,
  fingerprint        text        NOT NULL,
  created_at         timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS app_review_agent_report_checks_publish_request_idx
  ON app_review_agent_report_checks (publish_request_id);

COMMIT;
