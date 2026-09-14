// Re-export shim: this module moved to the @civitai/shared package so the moderator spoke can read
// the SAME area registry the producer writes, instead of hand-mirroring it.
// Existing call sites import from '~/shared/constants/feedback.constants' unchanged.
export * from '@civitai/shared/feedback.constants';
