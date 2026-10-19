export const LIMITS = {
  ROOM_MAX: 100,
  DESCRIPTION_MAX: 2000,
  COMMENT_MAX: 2000,
  DISPLAY_NAME_MAX: 200,
  ACTIVATION_CODE_LENGTH: 12,
  ACTIVATION_CODE_TTL_HOURS: 24,
  PAGE_SIZE: 8,
  MAX_PHOTOS: 5,
  TICKETS_PER_WINDOW: 5,
  TICKETS_WINDOW_MINUTES: 10,
  MAX_MESSAGE_LENGTH: 4000,
  USER_ACTIONS_PER_MINUTE: 30,
  SESSION_TTL_HOURS: 24,
  WEBHOOK_RETENTION_DAYS: 7,
  TICKET_NUMBER_MAX: 2_000_000_000,
} as const;

export const MAX_API = {
  /** Лимит MAX: не более 2 сообщений в секунду в один диалог. */
  SEND_INTERVAL_MS: 600,
  SEND_RETRIES: 3,
} as const;

export const SHUTDOWN_TIMEOUT_MS = 25_000;
export const WEBHOOK_PATH = '/webhook/max';
export const WEBHOOK_MAX_BODY_BYTES = 64 * 1024;

export const PATIENT_DATA_WARNING = 'Не указывайте персональные и медицинские данные пациентов.';
export const PHOTO_WARNING = 'На фото не должно быть пациентов, документов и экранов с их данными.';

export enum MaxMode {
  Polling = 'polling',
  Webhook = 'webhook',
}
