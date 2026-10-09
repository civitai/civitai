import type { ModerationAdapter } from '~/server/services/entity-moderation.service';

export type ApplyTextScanArgs = Parameters<NonNullable<ModerationAdapter['applyTextScan']>>[0];
