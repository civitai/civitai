import { createContext, useContext } from 'react';

/**
 * What is being reported, for forms that need to ask about it.
 *
 * `createReportForm` deliberately gives its Element no props — every form until
 * now only collected free text. A sticker report has to say *which* placement,
 * which means listing the ones on that image, so the target has to reach the
 * form somehow. A context keeps that to the one form that needs it instead of
 * threading an id through every other.
 */
type ReportTarget = {
  entityType: string;
  entityId: number;
  /**
   * The placement being reported. A sticker report starts from the sticker's own
   * flag, so this is always set on that path — there is no route that reaches
   * the form without it, and the form asks nothing about which sticker.
   */
  placementId?: number;
  /**
   * Which half of the placement the flag was on — the artwork or the note
   * hanging off it. Each has its own flag, so the reporter never picks: they
   * pressed the one next to the thing they object to.
   */
  placementTarget?: 'sticker' | 'comment';
};

const ReportTargetContext = createContext<ReportTarget | null>(null);

export const ReportTargetProvider = ReportTargetContext.Provider;

export const useReportTarget = () => useContext(ReportTargetContext);
