import type { Screen } from '../types/messenger';

/** Канал ответа конкретному входящему событию (callback или текстовое сообщение). */
export interface Responder {
  /** Показать экран: для callback заменяет сообщение с кнопкой, для текста — новое сообщение. */
  show(screen: Screen): Promise<void>;
  /** Короткая ошибка/уведомление. */
  notify(text: string): Promise<void>;
}
