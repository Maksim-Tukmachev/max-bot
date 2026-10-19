import type { Bot } from '@maxhub/max-bot-api';
import type { PrismaClient } from '@prisma/client';
import { LIMITS } from './config/constants';
import { registerBot } from './bot/bot';
import { UpdateRouter } from './bot/update-router';
import { AdminHandler } from './handlers/admin.handler';
import { SuperHandler } from './handlers/super.handler';
import { UserHandler } from './handlers/user.handler';
import { UserRateLimiter } from './middleware/user-rate-limit';
import { ActivationCodeRepository } from './repositories/activation-code.repository';
import { AuditRepository } from './repositories/audit.repository';
import { BranchRepository } from './repositories/branch.repository';
import { CommentRepository } from './repositories/comment.repository';
import { SessionRepository } from './repositories/session.repository';
import { TicketHistoryRepository } from './repositories/ticket-history.repository';
import { TicketRepository } from './repositories/ticket.repository';
import { UserRepository } from './repositories/user.repository';
import { WebhookRepository } from './repositories/webhook.repository';
import { ActivationService } from './services/activation.service';
import { AdminTicketService } from './services/admin-ticket.service';
import { AuditService } from './services/audit.service';
import { NotificationService } from './services/notification.service';
import { PermissionService } from './services/permission.service';
import { SessionService } from './services/session.service';
import { TicketService } from './services/ticket.service';
import { UserService } from './services/user.service';
import { WebhookDedupeService } from './services/webhook-dedupe.service';
import type { Messenger } from './types/messenger';
import type { Logger } from './utils/logger';

export interface Container {
  users: UserService;
  tickets: TicketService;
  adminTickets: AdminTicketService;
  activation: ActivationService;
  sessions: SessionService;
  dedupe: WebhookDedupeService;
  audit: AuditService;
  permissions: PermissionService;
  notifications: NotificationService;
  limiter: UserRateLimiter;
  router: UpdateRouter;
}

/** Корень композиции: единственное место, где собираются зависимости. Messenger подменяется в тестах. */
export function buildContainer(prisma: PrismaClient, messenger: Messenger, log: Logger): Container {
  const userRepo = new UserRepository();
  const branchRepo = new BranchRepository();
  const ticketRepo = new TicketRepository();
  const historyRepo = new TicketHistoryRepository();
  const commentRepo = new CommentRepository();
  const auditRepo = new AuditRepository();
  const sessionRepo = new SessionRepository();

  const audit = new AuditService(prisma, auditRepo, log);
  const permissions = new PermissionService(audit);
  const users = new UserService(prisma, userRepo, audit, permissions);
  const notifications = new NotificationService(messenger, users, log);
  const tickets = new TicketService(prisma, ticketRepo, branchRepo, historyRepo, commentRepo, audit, permissions, notifications, log);
  const adminTickets = new AdminTicketService(prisma, ticketRepo, userRepo, historyRepo, commentRepo, audit, permissions, notifications, log);
  const activation = new ActivationService(prisma, new ActivationCodeRepository(), audit, permissions);
  const sessions = new SessionService(prisma, sessionRepo);
  const dedupe = new WebhookDedupeService(prisma, new WebhookRepository());
  const limiter = new UserRateLimiter(LIMITS.USER_ACTIONS_PER_MINUTE);

  const router = new UpdateRouter(
    new UserHandler(prisma, tickets, sessions, branchRepo),
    new AdminHandler(adminTickets, sessions, users),
    new SuperHandler(users, activation),
    sessions,
    permissions,
    log,
  );

  return { users, tickets, adminTickets, activation, sessions, dedupe, audit, permissions, notifications, limiter, router };
}

export function wireBot(bot: Bot, c: Container, log: Logger): void {
  registerBot(bot, { router: c.router, users: c.users, dedupe: c.dedupe, audit: c.audit, limiter: c.limiter, log });
}

