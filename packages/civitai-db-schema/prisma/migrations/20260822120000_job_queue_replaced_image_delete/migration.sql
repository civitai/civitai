-- Replacing a profile picture used to destroy the previous image inline (row + stored
-- object), so every cached reference to it became a 404 rather than merely stale. The
-- replacement is now queued here and reaped by `remove-replaced-images` after a window
-- comfortably longer than the image CDN's 24h redirect TTL.
ALTER TYPE "JobQueueType" ADD VALUE IF NOT EXISTS 'ReplacedImageDelete';
