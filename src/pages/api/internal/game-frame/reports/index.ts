import { gameFrameReportHandler } from '~/server/game-frame/report-endpoints';

export const config = { api: { bodyParser: { sizeLimit: '16kb' } } };

export default gameFrameReportHandler;
