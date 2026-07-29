-- ChallengeCategory: judging-category library for challenges (docs/features/dynamic-challenge-judging-categories.md §5.1, D-DB).
-- label/group/criteria feed the client picker; rubric/rubricNsfw are the LLM scoring blocks.
-- MANUAL-APPLY PER ENVIRONMENT (repo convention — no prisma migrate deploy).
--
-- This file seeds structure + terse criteria. rubric/rubricNsfw content is environment data,
-- managed directly in each environment's DB (same handling as ChallengeJudge prompt content).

CREATE TABLE "ChallengeCategory" (
  "key"        VARCHAR(50) NOT NULL,
  "label"      VARCHAR(100) NOT NULL,
  "group"      VARCHAR(100) NOT NULL,
  "criteria"   TEXT NOT NULL,
  "rubric"     TEXT,
  "rubricNsfw" TEXT,
  "sortOrder"  INTEGER NOT NULL DEFAULT 0,
  "active"     BOOLEAN NOT NULL DEFAULT true,
  "createdAt"  TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"  TIMESTAMP(3) NOT NULL,

  CONSTRAINT "ChallengeCategory_pkey" PRIMARY KEY ("key")
);

CREATE INDEX "ChallengeCategory_active_idx" ON "ChallengeCategory"("active");

-- Structural seed from the preset library (src/shared/constants/challenge.constants.ts).
INSERT INTO "ChallengeCategory" ("key", "label", "group", "criteria", "sortOrder", "updatedAt")
VALUES
  ('theme', 'Theme', 'Universal', 'How well the entry fits and interprets the challenge theme; higher for a clear, strong, on-theme interpretation.', 0, CURRENT_TIMESTAMP),
  ('creativity', 'Creativity', 'Universal', 'Originality and inventiveness of the concept; higher for fresh, unexpected takes over clichés.', 10, CURRENT_TIMESTAMP),
  ('aesthetic', 'Aesthetic', 'Universal', 'Overall visual appeal — composition, color, lighting, and style; higher for striking, well-composed images.', 20, CURRENT_TIMESTAMP),
  ('technical', 'Technical Quality', 'Universal', 'Rendering correctness — coherent anatomy and objects, clean detail, minimal artifacts or distortions.', 30, CURRENT_TIMESTAMP),
  ('emotion', 'Emotional Impact', 'Universal', 'Mood and atmosphere; higher for images that strongly evoke a feeling.', 40, CURRENT_TIMESTAMP),
  ('storytelling', 'Storytelling', 'Universal', 'How well the image conveys a narrative or sense of scene; higher for a clear, compelling story.', 50, CURRENT_TIMESTAMP),
  ('gruesomeness', 'Gruesomeness', 'Horror / Dark', 'How visceral and gory the imagery is; higher for convincingly grisly, unsettling detail.', 60, CURRENT_TIMESTAMP),
  ('dread', 'Dread', 'Horror / Dark', 'Tension, unease, and a sense of impending danger; higher for a strong sense of dread.', 70, CURRENT_TIMESTAMP),
  ('creepiness', 'Creepiness', 'Horror / Dark', 'How eerie or disturbing the entry feels; higher for genuinely unnerving results.', 80, CURRENT_TIMESTAMP),
  ('shock', 'Shock Value', 'Horror / Dark', 'Boldness and impact; higher for provocatively surprising imagery.', 90, CURRENT_TIMESTAMP),
  ('humor', 'Humor', 'Comedy / Playful', 'How funny or amusing the entry is; higher for genuinely funny results.', 100, CURRENT_TIMESTAMP),
  ('wittiness', 'Wittiness', 'Comedy / Playful', 'Cleverness and conceptual wit of the idea; higher for sharp, clever concepts.', 110, CURRENT_TIMESTAMP),
  ('absurdity', 'Absurdity', 'Comedy / Playful', 'Surreal, ridiculous invention; higher for wonderfully absurd ideas.', 120, CURRENT_TIMESTAMP),
  ('cuteness', 'Cuteness', 'Cute / Wholesome', 'How adorable or endearing the subject is; higher for irresistibly cute results.', 130, CURRENT_TIMESTAMP),
  ('charm', 'Charm', 'Cute / Wholesome', 'Overall charm and likeability; higher for warm, appealing entries.', 140, CURRENT_TIMESTAMP),
  ('wholesomeness', 'Wholesomeness', 'Cute / Wholesome', 'How heartwarming or wholesome the mood is; higher for uplifting, feel-good images.', 150, CURRENT_TIMESTAMP),
  ('elegance', 'Elegance', 'Beauty / Glamour', 'Grace and refinement of the composition and subject; higher for elegant, polished results.', 160, CURRENT_TIMESTAMP),
  ('sensuality', 'Sensuality', 'Beauty / Glamour', 'Tasteful, confident allure; higher for compellingly sensual imagery.', 170, CURRENT_TIMESTAMP),
  ('glamour', 'Glamour', 'Beauty / Glamour', 'Glamour and style; higher for striking, fashionable presentation.', 180, CURRENT_TIMESTAMP),
  ('futurism', 'Futurism', 'Sci-Fi / Fantasy', 'How convincingly futuristic or high-tech the vision is; higher for imaginative, believable future tech.', 190, CURRENT_TIMESTAMP),
  ('worldbuilding', 'Worldbuilding', 'Sci-Fi / Fantasy', 'Depth and coherence of the world or setting; higher for rich, immersive environments.', 200, CURRENT_TIMESTAMP),
  ('epicness', 'Epicness', 'Sci-Fi / Fantasy', 'Scale and grandeur; higher for sweeping, awe-inspiring imagery.', 210, CURRENT_TIMESTAMP),
  ('detail', 'Detail', 'Sci-Fi / Fantasy', 'Richness and density of meaningful detail; higher for intricate, rewarding-to-explore images.', 220, CURRENT_TIMESTAMP),
  ('dynamism', 'Dynamism', 'Action / Drama', 'Sense of motion and energy; higher for dynamic, kinetic compositions.', 230, CURRENT_TIMESTAMP),
  ('intensity', 'Intensity', 'Action / Drama', 'Emotional or dramatic intensity; higher for gripping, high-stakes imagery.', 240, CURRENT_TIMESTAMP),
  ('cinematics', 'Cinematics', 'Action / Drama', 'Cinematic quality — lighting, framing, and mood like a film still; higher for cinematic results.', 250, CURRENT_TIMESTAMP)
ON CONFLICT ("key") DO NOTHING;
