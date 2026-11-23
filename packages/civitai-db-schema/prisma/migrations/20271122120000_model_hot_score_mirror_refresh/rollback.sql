-- Rollback for 20271122120000: mirrors go back to updating only when their own slice row is
-- written. Scores already refreshed stay as they are, which is the correct copy.

SET lock_timeout = '5s';

DROP TRIGGER IF EXISTS trg_model_metric_hot_score_mirror ON "ModelMetric";
DROP TRIGGER IF EXISTS trg_model_metric_hot_score_mirror_insert ON "ModelMetric";
DROP FUNCTION IF EXISTS public.model_metric_hot_score_mirror();
