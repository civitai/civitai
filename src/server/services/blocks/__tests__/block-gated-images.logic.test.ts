import { describe, it, expect } from 'vitest';

import { classifyGatedImageForViewer } from '~/server/services/blocks/block-gated-images.logic';
import { NsfwLevel } from '~/server/common/enums';
import { ImageIngestionStatus } from '~/shared/utils/prisma/enums';

// Viewer ceilings expressed as browsing-level bitmasks.
const SFW = NsfwLevel.PG | NsfwLevel.PG13; // 3 — a SFW viewer
const UP_TO_R = NsfwLevel.PG | NsfwLevel.PG13 | NsfwLevel.R; // 7 — an R-allowed viewer

const scannedClean = {
  ingestion: ImageIngestionStatus.Scanned,
  nsfwLevel: NsfwLevel.PG,
  needsReview: null,
  poi: false,
  minor: false,
  tosViolation: false,
  acceptableMinor: false,
};

describe('classifyGatedImageForViewer', () => {
  it('shows a scanned, clean, within-ceiling image', () => {
    expect(classifyGatedImageForViewer(scannedClean, SFW)).toEqual({ status: 'visible' });
  });

  it('HIDES an above-ceiling image from a viewer whose ceiling excludes it', () => {
    // An R image is hidden from a SFW viewer, but visible to an R-allowed viewer.
    const rImage = { ...scannedClean, nsfwLevel: NsfwLevel.R };
    expect(classifyGatedImageForViewer(rImage, SFW)).toEqual({ status: 'hidden' });
    expect(classifyGatedImageForViewer(rImage, UP_TO_R)).toEqual({ status: 'visible' });
  });

  it('HIDES an X image from an R-allowed viewer (still above their ceiling)', () => {
    const xImage = { ...scannedClean, nsfwLevel: NsfwLevel.X };
    expect(classifyGatedImageForViewer(xImage, UP_TO_R)).toEqual({ status: 'hidden' });
  });

  // ── REGRESSION (the "rated mature" defect) ────────────────────────────────
  // A freshly published image that NOTHING has rated yet must come back
  // `pending`, never `hidden`. The two states are what a caller renders from,
  // and collapsing them is what let a grid display an unrated lighthouse as
  // "Hidden — rated mature" — a maturity claim about an image with no rating.
  // These four assertions are `hidden` on pre-change code.
  it('reports a STILL-SCANNING image as pending, not hidden', () => {
    for (const ingestion of [
      ImageIngestionStatus.Pending,
      ImageIngestionStatus.PendingManualAssignment,
      ImageIngestionStatus.Error,
    ]) {
      expect(classifyGatedImageForViewer({ ...scannedClean, ingestion }, UP_TO_R)).toEqual({
        status: 'pending',
      });
    }
  });

  it('reports a scanned-but-unrated image (nsfwLevel 0) as pending, not hidden', () => {
    expect(classifyGatedImageForViewer({ ...scannedClean, nsfwLevel: 0 }, UP_TO_R)).toEqual({
      status: 'pending',
    });
  });

  it('treats an UNKNOWN ingestion value as pending (fail-safe: pending carries no url)', () => {
    expect(
      classifyGatedImageForViewer({ ...scannedClean, ingestion: 'SomeFutureState' }, UP_TO_R)
    ).toEqual({ status: 'pending' });
  });

  // ── The half that must NOT move ───────────────────────────────────────────
  it('HIDES the two TERMINAL scan refusals — Blocked / NotFound are NOT pending', () => {
    // `Blocked` = the scanner rejected the bytes; `NotFound` = it never fetched
    // them. Both are answers, not "not decided yet". If either were reported
    // `pending` the service would hand its author a url for prohibited content.
    for (const ingestion of [ImageIngestionStatus.Blocked, ImageIngestionStatus.NotFound]) {
      expect(classifyGatedImageForViewer({ ...scannedClean, ingestion }, UP_TO_R)).toEqual({
        status: 'hidden',
      });
    }
  });

  it('HIDES a FLAGGED row even while it is still scanning (moderation is decided first)', () => {
    // The flags are written at/after scan WITHOUT flipping `ingestion`, so this
    // combination is reachable. Ordering moderation ahead of the pending branch
    // is the only thing stopping a flagged row from reaching the owner url.
    const stillScanning = { ingestion: ImageIngestionStatus.Pending };
    const flaggedWhileScanning = [
      { ...scannedClean, ...stillScanning, needsReview: 'poi' },
      { ...scannedClean, ...stillScanning, poi: true },
      { ...scannedClean, ...stillScanning, minor: true },
      { ...scannedClean, ...stillScanning, tosViolation: true },
      { ...scannedClean, ...stillScanning, acceptableMinor: true },
      { ...scannedClean, ...stillScanning, blockedFor: 'CSAM' },
      // …and the same rows with no level written yet (the other pending route).
      { ...scannedClean, nsfwLevel: 0, tosViolation: true },
      { ...scannedClean, nsfwLevel: 0, blockedFor: 'CSAM' },
    ];
    for (const image of flaggedWhileScanning) {
      expect(classifyGatedImageForViewer(image, UP_TO_R)).toEqual({ status: 'hidden' });
    }
  });

  it('HIDES on ANY moderation flag a Scanned ingestion does not clear', () => {
    const flagged = [
      { ...scannedClean, needsReview: 'poi' },
      { ...scannedClean, poi: true },
      { ...scannedClean, minor: true },
      { ...scannedClean, tosViolation: true },
      { ...scannedClean, acceptableMinor: true },
      { ...scannedClean, blockedFor: 'CSAM' },
    ];
    for (const image of flagged) {
      expect(classifyGatedImageForViewer(image, UP_TO_R)).toEqual({ status: 'hidden' });
    }
  });

  it('HIDES everything when the viewer ceiling is empty (fail-closed 0 clamp)', () => {
    expect(classifyGatedImageForViewer(scannedClean, 0)).toEqual({ status: 'hidden' });
  });

  it('is a pure function of the row + ceiling — still NO identity parameter', () => {
    // The owner affordance lives in the SERVICE projection, never here: this
    // function takes no viewer id, so it cannot grant a bypass and cannot get one
    // wrong. Pinned by arity so a future `viewerIsOwner` argument has to come
    // through review rather than through a default.
    expect(classifyGatedImageForViewer.length).toBe(2);
  });
});
