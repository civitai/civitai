-- Add AwaitingSelection to ComicPanelStatus enum
ALTER TYPE "ComicPanelStatus" ADD VALUE IF NOT EXISTS 'AwaitingSelection' AFTER 'Generating';
