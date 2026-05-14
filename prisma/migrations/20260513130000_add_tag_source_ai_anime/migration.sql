-- Add per-source provenance for the new mediaRating classifier signals.
-- AiRecognition tags `ai`; AnimeRecognition tags `anime`.

ALTER TYPE "TagSource" ADD VALUE 'AiRecognition';
ALTER TYPE "TagSource" ADD VALUE 'AnimeRecognition';
