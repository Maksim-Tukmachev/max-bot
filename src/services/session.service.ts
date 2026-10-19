import { SessionState, type PrismaClient, type User } from '@prisma/client';
import { LIMITS } from '../config/constants';
import { draftSchema, type Draft } from '../security/input';
import { SessionRepository } from '../repositories/session.repository';

export interface SessionData {
  state: SessionState;
  draft: Draft;
}

export class SessionService {
  constructor(
    private readonly prisma: PrismaClient,
    private readonly repo: SessionRepository,
  ) {}

  async get(user: User): Promise<SessionData> {
    const row = await this.repo.find(this.prisma, user.id);
    if (!row) return { state: SessionState.IDLE, draft: {} };
    const expired = Date.now() - row.updatedAt.getTime() > LIMITS.SESSION_TTL_HOURS * 3_600_000;
    if (expired) {
      await this.repo.reset(this.prisma, user.id);
      return { state: SessionState.IDLE, draft: {} };
    }
    const parsed = draftSchema.safeParse(row.draft ?? {});
    return { state: row.state, draft: parsed.success ? parsed.data : {} };
  }

  async set(user: User, state: SessionState, draft: Draft): Promise<void> {
    await this.repo.set(this.prisma, user.id, state, draft);
  }

  claimConfirm(user: User): Promise<boolean> {
    return this.repo.claimConfirm(this.prisma, user.id);
  }

  async reset(user: User): Promise<void> {
    await this.repo.reset(this.prisma, user.id);
  }
}
