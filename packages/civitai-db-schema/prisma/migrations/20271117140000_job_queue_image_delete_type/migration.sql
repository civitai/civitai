-- Apply BEFORE the deploy: the deployed code writes this label, so its insert fails until the value
-- exists. Old pods are safe because none decodes a JobQueue type without filtering on its own (re-check
-- before adding an unfiltered reader).
ALTER TYPE "JobQueueType" ADD VALUE IF NOT EXISTS 'ImageDelete';
