export class AppError extends Error {
  constructor(
    message: string,
    /** Безопасный для показа пользователю текст. */
    readonly userMessage: string,
  ) {
    super(message);
    this.name = new.target.name;
  }
}

export class ForbiddenError extends AppError {
  constructor(detail: string) {
    super(detail, 'Недостаточно прав для этого действия.');
  }
}

export class NotFoundError extends AppError {
  constructor(detail: string) {
    super(detail, 'Заявка не найдена.');
  }
}

export class ValidationError extends AppError {
  constructor(userMessage: string) {
    super(userMessage, userMessage);
  }
}

export class ConflictError extends AppError {
  constructor(userMessage: string) {
    super(userMessage, userMessage);
  }
}

export const GENERIC_ERROR_MESSAGE = 'Что-то пошло не так. Попробуйте ещё раз позже.';
