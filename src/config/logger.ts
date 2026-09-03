import pino from 'pino';
import { env } from './env';

export const logger = pino({
  level: env.NODE_ENV === 'test' ? 'silent' : env.NODE_ENV === 'production' ? 'info' : 'debug',
  formatters: {
    level: (label) => ({ level: label }),
  },
  base: {
    service: 'lead-recorder-api',
  },
});
