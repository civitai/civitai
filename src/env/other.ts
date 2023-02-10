export const isMaintenanceMode = process.env.MAINTENANCE_MODE === 'true';
export const isDev = process.env.NODE_ENV === 'development';
export const isProd = process.env.NODE_ENV === 'production';
