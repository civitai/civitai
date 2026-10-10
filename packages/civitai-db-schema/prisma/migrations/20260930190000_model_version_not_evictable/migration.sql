-- Sets ModelVersionFlag.NotEvictable (bit 8, see
-- packages/civitai-shared/src/model-version-flags.constants.ts) on an initial, hand-picked set:
-- the default model of each self-hosted generation ecosystem as of 2026-09-30. The bit is the
-- source of truth, not that rule -- a new ecosystem or a changed default needs its own UPDATE.
-- The mini endpoint reports flagged versions as `evictable: false`.
--
-- Data only; safe to apply before or after the deploy (code that predates the bit ignores it).
-- Applied manually per environment; re-runnable.
--
-- Check before and after: 0 rows before, 28 after.
--   SELECT count(*) FROM "ModelVersion" WHERE flags & 8 = 8;
UPDATE "ModelVersion"
SET flags = flags | 8
WHERE id IN (
  128713,  -- SD1: DreamShaper 8
  128078,  -- SDXL 1.0 VAE fix
  290640,  -- Pony V6
  889818,  -- Illustrious v0.1
  1190596, -- NoobAI V-Pred 1.0
  2152373, -- Pony V7
  691639,  -- FLUX Dev
  2068000, -- FLUX Krea Dev
  2164239, -- Chroma v1.0-HD
  2612554, -- Flux.2 Klein 9B
  2612548, -- Flux.2 Klein 9B-Base
  2612557, -- Flux.2 Klein 4B
  2612552, -- Flux.2 Klein 4B-Base
  1771369, -- HiDream i1 dev fp8
  2939964, -- HiDream O1 Dev
  2442439, -- Z Image Turbo
  2635223, -- Z Image Base
  2552908, -- Qwen-Image-2512 fp8
  2863858, -- ERNIE-Image
  2945208, -- Anima base-v1.0
  2982236, -- Microsoft Lens
  3355635, -- Ming Image Design v0.1
  2578325, -- LTXV2 19b dev
  2749908, -- LTXV 2.3 Dev
  3220143, -- LTX 2.5 dev
  2864949, -- ACE-Step v1.5 XL Turbo
  3225593, -- MiniMax Music v3
  3337846  -- YuE2-3B
)
  AND flags & 8 = 0;
