-- Playlists: a collection of songs. Apply only after the regenerated client is deployed, and
-- before any playlist is created (the music flag gates creation).
ALTER TYPE "CollectionType" ADD VALUE IF NOT EXISTS 'Music';
