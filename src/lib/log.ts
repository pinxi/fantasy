import pino from 'pino';

const pretty = process.stdout.isTTY && process.env.NODE_ENV !== 'production';

export const log = pino(
  pretty
    ? { level: process.env.LOG_LEVEL ?? 'info', transport: { target: 'pino-pretty', options: { colorize: true } } }
    : { level: process.env.LOG_LEVEL ?? 'info' },
);
