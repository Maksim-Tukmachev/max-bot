export { Role, TicketStatus, CommentVisibility, SessionState } from '@prisma/client';

export enum AuditAction {
  AdminActivated = 'ADMIN_ACTIVATED',
  AdminCreated = 'ADMIN_CREATED',
  AdminDisabled = 'ADMIN_DISABLED',
  ActivationCodeCreated = 'ACTIVATION_CODE_CREATED',
  TicketCreated = 'TICKET_CREATED',
  TicketAccepted = 'TICKET_ACCEPTED',
  TicketStatusChanged = 'TICKET_STATUS_CHANGED',
  TicketTransferred = 'TICKET_TRANSFERRED',
  TicketCommentCreated = 'TICKET_COMMENT_CREATED',
  TicketClosed = 'TICKET_CLOSED',
  AccessDenied = 'ACCESS_DENIED',
}

export enum AuditEntity {
  User = 'User',
  Ticket = 'Ticket',
  ActivationCode = 'ActivationCode',
}
