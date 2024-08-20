 WITH entries AS (
         SELECT m."userId",
            (((((mvm."downloadCount" / 10) + (mvm."thumbsUpCount" * 3)) + (mvm."generationCount" / 100)))::numeric * ((1)::numeric - ((1)::numeric * ((EXTRACT(day FROM (now() - (mv."publishedAt")::timestamp with time zone)) / (30)::numeric) ^ (2)::numeric)))) AS score,
            mvm."thumbsUpCount",
            mvm."generationCount",
            mvm."downloadCount",
            mv."publishedAt",
            (m.meta ->> 'imageNsfw'::text) AS "nsfwLevel"
           FROM (("ModelVersionMetric" mvm
             JOIN "ModelVersion" mv ON ((mv.id = mvm."modelVersionId")))
             JOIN "Model" m ON ((mv."modelId" = m.id)))
          WHERE ((mv."publishedAt" > (CURRENT_DATE - '30 days'::interval)) AND (mvm.timeframe = 'Month'::"MetricTimeframe") AND (mv.status = 'Published'::"ModelStatus") AND (m.status = 'Published'::"ModelStatus"))
        ), entries_ranked AS (
         SELECT entries."userId",
            entries.score,
            entries."thumbsUpCount",
            entries."generationCount",
            entries."downloadCount",
            entries."publishedAt",
            entries."nsfwLevel",
            row_number() OVER (PARTITION BY entries."userId" ORDER BY entries.score DESC) AS rank
           FROM entries
        ), entries_multiplied AS (
         SELECT entries_ranked."userId",
            entries_ranked.score,
            entries_ranked."thumbsUpCount",
            entries_ranked."generationCount",
            entries_ranked."downloadCount",
            entries_ranked."publishedAt",
            entries_ranked."nsfwLevel",
            entries_ranked.rank,
            GREATEST((0)::double precision, ((1)::double precision - ((entries_ranked.rank)::double precision / (60)::double precision))) AS quantity_multiplier
           FROM entries_ranked
        )
 SELECT entries_multiplied."userId",
    entries_multiplied.score,
    entries_multiplied."thumbsUpCount",
    entries_multiplied."generationCount",
    entries_multiplied."downloadCount",
    entries_multiplied."publishedAt",
    entries_multiplied."nsfwLevel",
    entries_multiplied.rank,
    entries_multiplied.quantity_multiplier
   FROM entries_multiplied;