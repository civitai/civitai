// Re-export shim: this module moved to the @civitai/shared package so the creator-studio spoke can
// resolve base models too (media type drives the video pricing caps).
// Existing call sites import from '~/shared/constants/basemodel.constants' unchanged.
export * from '@civitai/shared/basemodel.constants';
