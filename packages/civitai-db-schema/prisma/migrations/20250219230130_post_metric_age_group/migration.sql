
ALTER TABLE "PostMetric"
ADD COLUMN IF NOT EXISTS "ageGroup" public."MetricTimeframe" DEFAULT 'Day'::public."MetricTimeframe" NOT NULL;
