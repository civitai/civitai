-- Add migration here
-- Create trigger function to sync boolean fields to Image.flags field

CREATE OR REPLACE FUNCTION update_image_flags()
RETURNS trigger
LANGUAGE plpgsql
AS $function$
DECLARE
    generator_engines text[] := ARRAY[
        'veo3','vidu', 'minimax','kling', 'lightricks','haiper', 'mochi','hunyuan', 'wan','sora'
    ];

    -- BIT DEFINITIONS ----------------------------------
    -- Bits 1-8: App-managed boolean flags (synced from boolean columns)
    BIT_NSFW_LEVEL_LOCKED CONSTANT integer := 1;      -- 2^0
    BIT_TOS_VIOLATION     CONSTANT integer := 2;      -- 2^1
    BIT_HIDE_META         CONSTANT integer := 4;      -- 2^2
    BIT_MINOR             CONSTANT integer := 8;      -- 2^3
    BIT_POI               CONSTANT integer := 16;     -- 2^4
    BIT_ACCEPTABLE_MINOR  CONSTANT integer := 32;     -- 2^5
    BIT_PROMPT_NSFW       CONSTANT integer := 64;     -- 2^6  (from ImageFlag table, deprecated)
    BIT_RESOURCES_NSFW    CONSTANT integer := 128;    -- 2^7  (from ImageFlag table, deprecated)

    -- Bits 9-12: Reserved for future use

    -- Bits 13-14: Trigger-managed flags (calculated from metadata)
    BIT_HAS_PROMPT        CONSTANT integer := 8192;   -- 2^13
    BIT_MADE_ON_SITE      CONSTANT integer := 16384;  -- 2^14

    -- Masks for different flag groups
    BOOLEAN_SYNC_MASK     CONSTANT integer := 63;     -- Bits 1-6 (1+2+4+8+16+32)
    TRIGGER_CALC_MASK     CONSTANT integer := 24576;  -- Bits 13-14 (8192+16384)

    -- Variables to hold calculated state
    v_boolean_flags integer := 0;
    v_calc_flags integer := 0;
    v_existing_flags integer := 0;
BEGIN
    ---------------------------------------------------------------------------
    -- PART 1: Sync Boolean Columns to Flags (Bits 1-6)
    ---------------------------------------------------------------------------
    -- Build flags from boolean columns
    IF NEW."nsfwLevelLocked" THEN v_boolean_flags := v_boolean_flags | BIT_NSFW_LEVEL_LOCKED; END IF;
    IF NEW."tosViolation"    THEN v_boolean_flags := v_boolean_flags | BIT_TOS_VIOLATION; END IF;
    IF NEW."hideMeta"        THEN v_boolean_flags := v_boolean_flags | BIT_HIDE_META; END IF;
    IF NEW."minor"           THEN v_boolean_flags := v_boolean_flags | BIT_MINOR; END IF;
    IF NEW."poi"             THEN v_boolean_flags := v_boolean_flags | BIT_POI; END IF;
    IF NEW."acceptableMinor" THEN v_boolean_flags := v_boolean_flags | BIT_ACCEPTABLE_MINOR; END IF;

    ---------------------------------------------------------------------------
    -- PART 2: Calculate Trigger-Managed Flags (Bits 13-14)
    ---------------------------------------------------------------------------
    -- Only recalculate if meta changed (optimization)
    IF (TG_OP = 'INSERT') OR (NEW.meta IS DISTINCT FROM OLD.meta) THEN
        -- Check for prompt
        IF (NEW.meta->>'prompt' IS NOT NULL) THEN
            v_calc_flags := v_calc_flags | BIT_HAS_PROMPT;
        END IF;

        -- Check for onSite generation
        IF (
            ((NEW.meta->>'civitaiResources' IS NOT NULL) AND NOT (NEW.meta ? 'Version'))
            OR
            (NEW.meta->>'engine' = ANY(generator_engines))
        ) THEN
            v_calc_flags := v_calc_flags | BIT_MADE_ON_SITE;
        END IF;
    ELSE
        -- Meta didn't change, preserve existing trigger bits
        v_calc_flags := NEW.flags & TRIGGER_CALC_MASK;
    END IF;

    ---------------------------------------------------------------------------
    -- PART 3: Preserve ImageFlag Bits (Bits 7-8) if they exist
    ---------------------------------------------------------------------------
    -- These bits might be set by external processes or migration
    -- We don't want to clear them, so preserve them
    v_existing_flags := NEW.flags & (BIT_PROMPT_NSFW | BIT_RESOURCES_NSFW);

    ---------------------------------------------------------------------------
    -- PART 4: Merge All Flag Groups
    ---------------------------------------------------------------------------
    -- Final flags = boolean sync (1-6) | imageFlag preserve (7-8) | trigger calc (13-14)
    NEW.flags := v_boolean_flags | v_existing_flags | v_calc_flags;

    RETURN NEW;
END;
$function$;

---

-- Create or replace the trigger
DROP TRIGGER IF EXISTS trg_update_image_flags ON "Image";
CREATE TRIGGER trg_update_image_flags
    BEFORE INSERT OR UPDATE ON "Image"
    FOR EACH ROW
    EXECUTE FUNCTION update_image_flags();
