import { z } from 'zod';
import { MaxMode } from './constants';
import { isValidTimezone } from './timezone';

const secretRegex = /^[A-Za-z0-9_-]{5,256}$/;

const schema = z
  .object({
    NODE_ENV: z.enum(['development', 'test', 'production']).default('production'),
    PORT: z.coerce.number().int().min(1).max(65535).default(3000),
    LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),
    DATABASE_URL: z.string().min(1),
    MAX_BOT_TOKEN: z.string().min(10),
    MAX_MODE: z.nativeEnum(MaxMode).default(MaxMode.Polling),
    MAX_WEBHOOK_DOMAIN: z.string().optional(),
    MAX_WEBHOOK_SECRET: z.string().regex(secretRegex).optional(),
    REPORT_TIMEZONE: z.string().refine(isValidTimezone, 'неизвестный часовой пояс (пример: Europe/Moscow)').optional(),
    SUPERADMIN_MAX_USER_ID: z
      .string()
      .regex(/^\d{1,18}$/, 'SUPERADMIN_MAX_USER_ID должен быть числом')
      .optional(),
  })
  .superRefine((env, ctx) => {
    if (env.MAX_MODE === MaxMode.Webhook) {
      if (!env.MAX_WEBHOOK_DOMAIN) {
        ctx.addIssue({ code: 'custom', path: ['MAX_WEBHOOK_DOMAIN'], message: 'обязателен в режиме webhook' });
      }
      if (!env.MAX_WEBHOOK_SECRET) {
        ctx.addIssue({ code: 'custom', path: ['MAX_WEBHOOK_SECRET'], message: 'обязателен в режиме webhook' });
      }
    }
  });

export type Env = z.infer<typeof schema>;

export function loadEnv(source: NodeJS.ProcessEnv = process.env): Env {
  // Пустое значение в .env (`KEY=`) означает «не задано».
  const cleaned = Object.fromEntries(Object.entries(source).filter(([, v]) => v !== undefined && v.trim() !== ''));
  const parsed = schema.safeParse(cleaned);
  if (!parsed.success) {
    // Значения переменных не выводим — только имена и причины.
    const problems = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
    throw new Error(`Некорректная конфигурация окружения: ${problems}`);
  }
  return parsed.data;
}
