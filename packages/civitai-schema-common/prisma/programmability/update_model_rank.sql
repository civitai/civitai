-- Create the stored procedure
CREATE OR REPLACE PROCEDURE update_model_rank(batch_size INT)
    LANGUAGE plpgsql
AS
$$
DECLARE
    total_rows     INT;
    rows_processed INT := 0;
BEGIN
    RAISE NOTICE 'Preparing temp table';
    -- Create a temporary table to store the new data
    -- The 'hope' of using a temp table would be that it doesn't replicate to the read replicas
    DROP TABLE IF EXISTS "ModelRank_Temp";
    CREATE LOCAL TEMP TABLE "ModelRank_Temp" AS
    SELECT * FROM "ModelRank_Live";

    RAISE NOTICE 'Adding a primary key';
    ALTER TABLE "ModelRank_Temp" ADD PRIMARY KEY ("modelId");

    RAISE NOTICE 'Determining number of rows';

    -- Get the total number of rows in the temporary table
    SELECT COUNT(*) INTO total_rows FROM "ModelRank_Temp";

    RAISE NOTICE 'Inserting % rows in batch size %', total_rows, batch_size;

    -- Loop through the data in batches
    FOR batch_offset IN 1..total_rows BY batch_size
        LOOP
            -- Insert data from the temporary table into the permanent table
            INSERT INTO "ModelRank"
            SELECT *
            FROM "ModelRank_Temp"
            ORDER BY "modelId" -- Order by a column to ensure consistent results
            LIMIT batch_size OFFSET batch_offset
            ON CONFLICT ("modelId") DO UPDATE SET
              "downloadCountDay"             = EXCLUDED."downloadCountDay",
              "downloadCountWeek"            = EXCLUDED."downloadCountWeek",
              "downloadCountMonth"           = EXCLUDED."downloadCountMonth",
              "downloadCountYear"            = EXCLUDED."downloadCountYear",
              "downloadCountAllTime"         = EXCLUDED."downloadCountAllTime",
              "downloadCountDayRank"         = EXCLUDED."downloadCountDayRank",
              "downloadCountWeekRank"        = EXCLUDED."downloadCountWeekRank",
              "downloadCountMonthRank"       = EXCLUDED."downloadCountMonthRank",
              "downloadCountYearRank"        = EXCLUDED."downloadCountYearRank",
              "downloadCountAllTimeRank"     = EXCLUDED."downloadCountAllTimeRank",
              "ratingCountDay"               = EXCLUDED."ratingCountDay",
              "ratingCountWeek"              = EXCLUDED."ratingCountWeek",
              "ratingCountMonth"             = EXCLUDED."ratingCountMonth",
              "ratingCountYear"              = EXCLUDED."ratingCountYear",
              "ratingCountAllTime"           = EXCLUDED."ratingCountAllTime",
              "ratingCountDayRank"           = EXCLUDED."ratingCountDayRank",
              "ratingCountWeekRank"          = EXCLUDED."ratingCountWeekRank",
              "ratingCountMonthRank"         = EXCLUDED."ratingCountMonthRank",
              "ratingCountYearRank"          = EXCLUDED."ratingCountYearRank",
              "ratingCountAllTimeRank"       = EXCLUDED."ratingCountAllTimeRank",
              "ratingDay"                    = EXCLUDED."ratingDay",
              "ratingWeek"                   = EXCLUDED."ratingWeek",
              "ratingMonth"                  = EXCLUDED."ratingMonth",
              "ratingYear"                   = EXCLUDED."ratingYear",
              "ratingAllTime"                = EXCLUDED."ratingAllTime",
              "ratingDayRank"                = EXCLUDED."ratingDayRank",
              "ratingWeekRank"               = EXCLUDED."ratingWeekRank",
              "ratingMonthRank"              = EXCLUDED."ratingMonthRank",
              "ratingYearRank"               = EXCLUDED."ratingYearRank",
              "ratingAllTimeRank"            = EXCLUDED."ratingAllTimeRank",
              "favoriteCountDay"             = EXCLUDED."favoriteCountDay",
              "favoriteCountWeek"            = EXCLUDED."favoriteCountWeek",
              "favoriteCountMonth"           = EXCLUDED."favoriteCountMonth",
              "favoriteCountYear"            = EXCLUDED."favoriteCountYear",
              "favoriteCountAllTime"         = EXCLUDED."favoriteCountAllTime",
              "favoriteCountDayRank"         = EXCLUDED."favoriteCountDayRank",
              "favoriteCountWeekRank"        = EXCLUDED."favoriteCountWeekRank",
              "favoriteCountMonthRank"       = EXCLUDED."favoriteCountMonthRank",
              "favoriteCountYearRank"        = EXCLUDED."favoriteCountYearRank",
              "favoriteCountAllTimeRank"     = EXCLUDED."favoriteCountAllTimeRank",
              "commentCountDay"              = EXCLUDED."commentCountDay",
              "commentCountWeek"             = EXCLUDED."commentCountWeek",
              "commentCountMonth"            = EXCLUDED."commentCountMonth",
              "commentCountYear"             = EXCLUDED."commentCountYear",
              "commentCountAllTime"          = EXCLUDED."commentCountAllTime",
              "commentCountDayRank"          = EXCLUDED."commentCountDayRank",
              "commentCountWeekRank"         = EXCLUDED."commentCountWeekRank",
              "commentCountMonthRank"        = EXCLUDED."commentCountMonthRank",
              "commentCountYearRank"         = EXCLUDED."commentCountYearRank",
              "commentCountAllTimeRank"      = EXCLUDED."commentCountAllTimeRank",
              "imageCountDay"                = EXCLUDED."imageCountDay",
              "imageCountWeek"               = EXCLUDED."imageCountWeek",
              "imageCountMonth"              = EXCLUDED."imageCountMonth",
              "imageCountYear"               = EXCLUDED."imageCountYear",
              "imageCountAllTime"            = EXCLUDED."imageCountAllTime",
              "imageCountDayRank"            = EXCLUDED."imageCountDayRank",
              "imageCountWeekRank"           = EXCLUDED."imageCountWeekRank",
              "imageCountMonthRank"          = EXCLUDED."imageCountMonthRank",
              "imageCountYearRank"           = EXCLUDED."imageCountYearRank",
              "imageCountAllTimeRank"        = EXCLUDED."imageCountAllTimeRank",
              "collectedCountDay"            = EXCLUDED."collectedCountDay",
              "collectedCountWeek"           = EXCLUDED."collectedCountWeek",
              "collectedCountMonth"          = EXCLUDED."collectedCountMonth",
              "collectedCountYear"           = EXCLUDED."collectedCountYear",
              "collectedCountAllTime"        = EXCLUDED."collectedCountAllTime",
              "collectedCountDayRank"        = EXCLUDED."collectedCountDayRank",
              "collectedCountWeekRank"       = EXCLUDED."collectedCountWeekRank",
              "collectedCountMonthRank"      = EXCLUDED."collectedCountMonthRank",
              "collectedCountYearRank"       = EXCLUDED."collectedCountYearRank",
              "collectedCountAllTimeRank"    = EXCLUDED."collectedCountAllTimeRank",
              "newRank"                      = EXCLUDED."newRank",
              "age_days"                     = EXCLUDED."age_days",
              "tippedCountDay"               = EXCLUDED."tippedCountDay",
              "tippedCountWeek"              = EXCLUDED."tippedCountWeek",
              "tippedCountMonth"             = EXCLUDED."tippedCountMonth",
              "tippedCountYear"              = EXCLUDED."tippedCountYear",
              "tippedCountAllTime"           = EXCLUDED."tippedCountAllTime",
              "tippedCountDayRank"           = EXCLUDED."tippedCountDayRank",
              "tippedCountWeekRank"          = EXCLUDED."tippedCountWeekRank",
              "tippedCountMonthRank"         = EXCLUDED."tippedCountMonthRank",
              "tippedCountYearRank"          = EXCLUDED."tippedCountYearRank",
              "tippedCountAllTimeRank"       = EXCLUDED."tippedCountAllTimeRank",
              "tippedAmountCountDay"         = EXCLUDED."tippedAmountCountDay",
              "tippedAmountCountWeek"        = EXCLUDED."tippedAmountCountWeek",
              "tippedAmountCountMonth"       = EXCLUDED."tippedAmountCountMonth",
              "tippedAmountCountYear"        = EXCLUDED."tippedAmountCountYear",
              "tippedAmountCountAllTime"     = EXCLUDED."tippedAmountCountAllTime",
              "tippedAmountCountDayRank"     = EXCLUDED."tippedAmountCountDayRank",
              "tippedAmountCountWeekRank"    = EXCLUDED."tippedAmountCountWeekRank",
              "tippedAmountCountMonthRank"   = EXCLUDED."tippedAmountCountMonthRank",
              "tippedAmountCountYearRank"    = EXCLUDED."tippedAmountCountYearRank",
              "tippedAmountCountAllTimeRank" = EXCLUDED."tippedAmountCountAllTimeRank",
              "generationCountDayRank"       = EXCLUDED."generationCountDayRank",
              "generationCountWeekRank"      = EXCLUDED."generationCountWeekRank",
              "generationCountMonthRank"     = EXCLUDED."generationCountMonthRank",
              "generationCountYearRank"      = EXCLUDED."generationCountYearRank",
              "generationCountAllTimeRank"   = EXCLUDED."generationCountAllTimeRank",
              "generationCountDay"           = EXCLUDED."generationCountDay",
              "generationCountWeek"          = EXCLUDED."generationCountWeek",
              "generationCountMonth"         = EXCLUDED."generationCountMonth",
              "generationCountYear"          = EXCLUDED."generationCountYear",
              "generationCountAllTime"       = EXCLUDED."generationCountAllTime";

            -- Update the number of rows processed
            rows_processed := rows_processed + batch_size;

            -- Optional: Take a small break
            -- pg_sleep(1)

            RAISE NOTICE 'Batch: % / %', rows_processed, total_rows;
            COMMIT;

            -- Exit the loop if all rows have been processed
            EXIT WHEN rows_processed >= total_rows;
        END LOOP;

    -- Cleanup in case of session reuse
    DROP TABLE IF EXISTS "ModelRank_Temp";
END ;
$$;
