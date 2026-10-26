import { z } from 'zod';
import { LIMITS } from '../config/constants';
import { normalizeText } from '../utils/text';

const text = (max: number) =>
  z
    .string()
    .transform(normalizeText)
    .pipe(z.string().min(1, 'Поле не может быть пустым.').max(max, `Максимум ${max} символов.`));

export const roomSchema = text(LIMITS.ROOM_MAX);
export const descriptionSchema = text(LIMITS.DESCRIPTION_MAX);
export const commentSchema = text(LIMITS.COMMENT_MAX);
export const archiveQuerySchema = text(LIMITS.ARCHIVE_QUERY_MAX);
export const ticketNumberSchema = z.coerce.number().int().min(1).max(LIMITS.TICKET_NUMBER_MAX);
export const activationCodeSchema = z
  .string()
  .transform((s) => s.trim().toUpperCase())
  .pipe(z.string().regex(/^[A-Z2-9]{8,32}$/, 'Неверный формат кода.'));

export const photoSchema = z.object({
  token: z.string().min(1).max(500),
  photoId: z.number().int().optional(),
});
export type PhotoRef = z.infer<typeof photoSchema>;

export const draftSchema = z.object({
  branchId: z.number().int().optional(),
  room: z.string().max(LIMITS.ROOM_MAX).optional(),
  description: z.string().max(LIMITS.DESCRIPTION_MAX).optional(),
  ticketNumber: z.number().int().optional(),
  commentKind: z.enum(['internal', 'user']).optional(),
  archiveQuery: z.string().max(LIMITS.ARCHIVE_QUERY_MAX).optional(),
  archivePeriod: z.enum(['t', 'w', 'm', 'a']).optional(),
  archiveBranch: z.number().int().optional(),
  photos: z.array(photoSchema).max(LIMITS.MAX_PHOTOS).optional(),
});
export type Draft = z.infer<typeof draftSchema>;

/** Возвращает текст ошибки валидации для пользователя либо значение. */
export function parseInput<T>(schema: z.ZodType<T>, value: string): { ok: true; value: T } | { ok: false; error: string } {
  const r = schema.safeParse(value);
  if (r.success) return { ok: true, value: r.data };
  return { ok: false, error: r.error.issues[0]?.message ?? 'Некорректное значение.' };
}
