import pino from 'pino';

export const logger = pino({
  level: process.env.LOG_LEVEL ?? 'info',
  base: { app: 'max-helpdesk' },
  timestamp: pino.stdTimeFunctions.isoTime,
  redact: {
    paths: [
      '*.token',
      '*.secret',
      '*.password',
      '*.authorization',
      'token',
      'secret',
      'password',
      'authorization',
      'databaseUrl',
      'req.headers.authorization',
      'req.headers["x-max-bot-api-secret"]',
    ],
    censor: '[REDACTED]',
  },
  serializers: {
    err: pino.stdSerializers.err,
  },
});

export type Logger = typeof logger;
