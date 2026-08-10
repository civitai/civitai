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
type ReportTarget = { entityType: string; entityId: number };

const ReportTargetContext = createContext<ReportTarget | null>(null);

export const ReportTargetProvider = ReportTargetContext.Provider;

export const useReportTarget = () => useContext(ReportTargetContext);
