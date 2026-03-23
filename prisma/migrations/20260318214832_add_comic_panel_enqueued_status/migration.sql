-- Add Enqueued status to ComicPanelStatus enum
ALTER TYPE "ComicPanelStatus" ADD VALUE 'Enqueued' AFTER 'Pending';
