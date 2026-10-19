/** Кнопки в независимом от SDK виде; в SDK-формат превращаются в bot/max-messenger.ts. */
export interface ButtonDef {
  text: string;
  payload: string;
}
export type KeyboardDef = ButtonDef[][];

export interface Screen {
  text: string;
  keyboard?: KeyboardDef;
  /** Токены изображений MAX, прикладываются к сообщению. */
  images?: string[];
}

export interface Messenger {
  /** Отправка сообщения пользователю MAX (по MAX user_id). Не бросает исключений: возвращает false при ошибке. */
  sendToUser(maxUserId: bigint, screen: Screen): Promise<boolean>;
}
