# MAX Helpdesk Bot — архитектура (этап 1, на согласование)

Стек: Node.js 22 LTS + TypeScript (strict) + Fastify + Zod + PostgreSQL 16 + Prisma + Docker Compose + Nginx.
Кода приложения пока нет — только проектные решения.

## 1. Что подтверждает документация MAX

Источники: dev.max.ru/docs/chatbots/bots-coding/js, github max-messenger/max-bot-api-client-ts, dev.max.ru/docs-api (subscriptions, messages).

| Факт | Источник | Влияние |
|---|---|---|
| SDK: `@maxhub/max-bot-api`, `new Bot(token)`, `bot.api.sendMessageToUser(userId, text, extra)`, `Keyboard.inlineKeyboard([[Keyboard.button.callback(text, payload)]])`, `ctx.api.raw.post/patch` | js-гайд | используем для отправки и клавиатур |
| События: `bot_started`, `message_created`, `message_callback` и др. | js-гайд | обрабатываем три типа, остальные игнорируем |
| Гайд и README SDK показывают только long polling (`bot.start()`); про webhook в SDK ничего нет | js-гайд, README | **нужна проверка:** умеет ли SDK принимать Update снаружи. План: свой Fastify-роут + Zod-валидация Update, SDK только как API-клиент |
| Webhook: `POST /subscriptions` на `platform-api2.max.ru`, тело `{url, update_types?, secret?}`, заголовок `Authorization: <token>` | docs-api | скрипт регистрации `scripts/register-webhook.ts` |
| Секрет: 5–256 символов `[A-Za-z0-9_-]`, приходит в заголовке `X-Max-Bot-Api-Secret` | docs-api | сверяем в constant-time; секрет генерируем `openssl rand -hex 32` |
| Только HTTPS:443, сертификат от доверенного УЦ (или Минцифры), полная цепочка, домен = CN/SAN, самоподписанные не поддерживаются | docs-api | Nginx обязан иметь публичный домен и настоящий сертификат |
| Ответ 200 за ≤30 с; до 10 повторов с backoff (60 с, 150 с, 375 с, …); отписка после 8 часов неудач | docs-api | дедупликация обязательна; обработку держим быстрой |
| `POST /messages?user_id=`: текст ≤4000 символов, `format: markdown\|html`, `attachments`; лимит 2 сообщения/с на диалог | docs-api | разбиваем длинные тексты, троттлим рассылку админам |
| `POST /answers` — ответ на callback; `PUT/DELETE /messages` — правка/удаление | docs-api | на callback отвечаем, экраны обновляем правкой сообщения |

### Расхождения ТЗ и документации, требующие решения
1. **Webhook против публичной доступности.** MAX шлёт события из интернета на HTTPS:443 с валидным сертификатом. Машина на РЕД ОС должна быть доступна снаружи по домену. Для медучреждения это существенный сетевой вопрос. Альтернатива: long polling, где соединение исходящее и ничего публиковать не нужно. ТЗ требует webhook, поэтому делаю webhook. Но стоит уточнить у сетевиков, можно ли открыть 443.
2. **`externalEventId`.** В найденной документации у Update нет явного уникального id события. Ключ дедупликации строю из полей события:
   - `message_created` → `mid`;
   - `message_callback` → `callback_id`;
   - `bot_started` → `user_id:timestamp`.

   Точные имена полей сверю с реальным payload до написания кода (залогировать первые события).
3. **Лимит длины callback payload** в доке не найден. Держу payload коротким (`tk:<id>:acc`) и проверяю на сервере.
4. **Таблицы вне списка ТЗ, но необходимые:** `UserSession` (состояние FSM, у MAX нет встроенного), `AdminActivationCode`, счётчик номеров заявок.

## 2. Архитектура

```
MAX ──HTTPS:443──► Nginx ──► app:3000 (Fastify)
                               │ POST /webhook/max
                               ▼
        [security] secret check → Zod(Update) → dedupe (ProcessedWebhook)
                               ▼
                 handler (router по update-типу / FSM-шагу)
                               ▼
                 service (бизнес-правила, права, аудит)
                               ▼
                 repository ──► Prisma ──► PostgreSQL (internal network)
                               ▼
                 notifier ──► MAX API (POST /messages, /answers)
```

Принципы:
- **Монолит**, один процесс. Redis нет, состояние FSM лежит в PostgreSQL.
- **Слои:** handler не знает про Prisma, service не знает про MAX-типы. Notifier вызывается после коммита транзакции.
- **Роль берётся из БД по `maxUserId`** на каждую операцию. `PermissionService.require(user, Permission)` вызывается в каждом admin-сервисе. Отказ пишет `ACCESS_DENIED` в аудит.
- **Callback data не доверяем.** Формат разбирается Zod. Дальше сервер проверяет, что заявка существует, что пользователь имеет к ней доступ, что переход статуса допустим. Кнопки строятся от роли и статуса, но проверка повторяется при нажатии.
- **Конкурентное принятие:** один атомарный SQL внутри транзакции:
  `UPDATE "Ticket" SET status='IN_PROGRESS', "assignedAdminId"=$a, "acceptedAt"=now() WHERE id=$t AND status='NEW' AND "assignedAdminId" IS NULL`
  Через Prisma это `updateMany`. Если `count=0`, второй админ получает «Заявку уже принял другой администратор». История и аудит пишутся в той же транзакции. Тест гоняет `Promise.all` из двух принятий на реальном PostgreSQL.
- **Номер заявки** из PostgreSQL sequence (`autoincrement` в поле `number`), уникален без гонок.
- **Дедупликация:** `INSERT ... ON CONFLICT DO NOTHING` в `ProcessedWebhook`. Если вставки не было, сразу отвечаем 200 и не обрабатываем. Запись создаём в той же транзакции, что и обработка, чтобы при падении повтор от MAX отработал. Старые записи чистим по cron внутри приложения (>7 дней).
- **Ошибки:** централизованный error handler. Пользователю уходит общее «Что-то пошло не так», подробности только в JSON-лог (pino с redact токена, секрета и `DATABASE_URL`).
- **Webhook всегда отвечает 200** на валидный по секрету запрос, даже при внутренней ошибке обработки, чтобы не провоцировать лавину повторов. Исключения: неверный секрет → 401, битый JSON → 400.
- **Роли:** `superadmin` создаёт одноразовый код активации (хранится хеш SHA-256, TTL 24 ч, одноразовый). Сотрудник отправляет боту `/activate <код>`. Сообщение с кодом после использования удаляется через `DELETE /messages`, если API позволит. Первого superadmin создаёт скрипт `scripts/create-superadmin.ts`, который печатает код в stdout один раз.
- **Rate limiting:** `@fastify/rate-limit` на уровне IP (Nginx `limit_req` плюс Fastify) и на пользователя по `maxUserId` в сервисе, например 20 действий в минуту.
- **Graceful shutdown:** `SIGTERM/SIGINT` → `fastify.close()` (перестаёт принимать и ждёт активные запросы) → `prisma.$disconnect()` → `exit(0)`, таймаут 25 с. В compose `stop_grace_period: 30s`.

### FSM создания заявки
`UserSession{userId, state, draft(JSON), updatedAt}`:
`IDLE → SELECT_BRANCH → ENTER_ROOM → ENTER_DESCRIPTION → CONFIRM → CREATED(→IDLE)`.
- Кнопки «Изменить» и «Отмена» доступны на CONFIRM.
- Текстовые сообщения вне ожидаемого шага игнорируются или направляются в главное меню.
- Сессии старше 24 ч сбрасываются в IDLE.
- На экране ввода показывается предупреждение: «Не указывайте персональные и медицинские данные пациентов.»

### Матрица кнопок карточки (админ)
| Статус | Кнопки |
|---|---|
| NEW | Принять · Комментарий · История |
| IN_PROGRESS (мой) | Изменить статус · Комментарий · Передать · История |
| WAITING_USER / POSTPONED (мой) | Вернуть в работу · Комментарий · История |
| RESOLVED (мой) | Закрыть · Вернуть в работу · История |
| CLOSED | История |
| чужая заявка | История, комментарий; изменения только у `superadmin` |

Допустимые переходы статусов задаются одной таблицей в `domain/ticket-transitions.ts`, на неё опираются и кнопки, и проверки сервиса.

## 3. Дерево проекта

```
max-bot-dksp/
├── src/
│   ├── index.ts                  # только bootstrap
│   ├── app.ts                    # сборка Fastify, плагины, error handler
│   ├── config/                   # env.ts (Zod), constants.ts
│   ├── domain/                   # enums-реэкспорт, ticket-transitions.ts, permissions.ts
│   ├── routes/                   # health.route.ts, webhook.route.ts
│   ├── controllers/              # webhook.controller.ts
│   ├── middleware/               # webhook-secret.ts, error-handler.ts, rate-limit.ts
│   ├── security/                 # secret-compare.ts, callback-data.ts, redact.ts
│   ├── bot/                      # max-client.ts (обёртка SDK), update-router.ts, session.ts
│   ├── handlers/                 # start, menu, create-ticket, my-tickets, admin-*, activate, search
│   ├── keyboards/                # user.keyboards.ts, admin.keyboards.ts, ticket-card.keyboard.ts
│   ├── messages/                 # тексты (ru), форматтеры карточек
│   ├── services/                 # ticket, admin-ticket, notification, user, auth(activation),
│   │                             # audit, permission, webhook-dedupe, session
│   ├── repositories/             # user, branch, ticket, comment, history, audit, session, webhook
│   ├── utils/                    # logger.ts, prisma.ts, pagination.ts, text-split.ts
│   └── types/                    # update.schemas.ts (Zod), max-api.types.ts
├── prisma/{schema.prisma, migrations/, seed.ts}
├── nginx/{nginx.conf, conf.d/helpdesk.conf}
├── scripts/{backup.sh, restore.sh, register-webhook.ts, create-superadmin.ts}
├── tests/{unit/, integration/}
├── docker-compose.yml  Dockerfile  .env.example  .gitignore  .dockerignore
├── package.json  tsconfig.json  README.md
```

## 4. Prisma schema

```prisma
generator client {
  provider = "prisma-client-js"
  binaryTargets = ["native", "debian-openssl-3.0.x"]
}
datasource db {
  provider = "postgresql"
  url      = env("DATABASE_URL")
}

enum Role             { USER ADMIN SUPERADMIN }
enum TicketStatus     { NEW IN_PROGRESS WAITING_USER POSTPONED RESOLVED CLOSED }
enum CommentVisibility{ INTERNAL USER }
enum SessionState     { IDLE SELECT_BRANCH ENTER_ROOM ENTER_DESCRIPTION CONFIRM }

model User {
  id           Int      @id @default(autoincrement())
  maxUserId    BigInt   @unique
  displayName  String   @db.VarChar(200)
  role         Role     @default(USER)
  isActive     Boolean  @default(true)
  createdAt    DateTime @default(now())
  lastSeenAt   DateTime @default(now())

  tickets          Ticket[]        @relation("TicketAuthor")
  assignedTickets  Ticket[]        @relation("TicketAssignee")
  comments         TicketComment[]
  statusChanges    TicketStatusHistory[]
  auditLogs        AuditLog[]
  session          UserSession?
  createdCodes     AdminActivationCode[] @relation("CodeCreator")
  usedCodes        AdminActivationCode[] @relation("CodeUser")

  @@index([role, isActive])
}

model Branch {
  id        Int     @id @default(autoincrement())
  name      String  @unique @db.VarChar(200)
  isActive  Boolean @default(true)
  sortOrder Int     @default(0)
  tickets   Ticket[]
}

model Ticket {
  id              Int          @id @default(autoincrement())
  number          Int          @unique @default(autoincrement())
  userId          Int
  branchId        Int
  room            String       @db.VarChar(100)
  description     String       @db.VarChar(2000)
  status          TicketStatus @default(NEW)
  assignedAdminId Int?
  createdAt       DateTime     @default(now())
  updatedAt       DateTime     @updatedAt
  acceptedAt      DateTime?
  resolvedAt      DateTime?
  closedAt        DateTime?

  user          User   @relation("TicketAuthor",   fields: [userId],          references: [id])
  assignedAdmin User?  @relation("TicketAssignee", fields: [assignedAdminId], references: [id])
  branch        Branch @relation(fields: [branchId], references: [id])
  comments      TicketComment[]
  history       TicketStatusHistory[]

  @@index([status, createdAt])
  @@index([assignedAdminId, status])
  @@index([userId, status])
}

model TicketComment {
  id         Int               @id @default(autoincrement())
  ticketId   Int
  authorId   Int
  text       String            @db.VarChar(2000)
  visibility CommentVisibility
  createdAt  DateTime          @default(now())
  ticket Ticket @relation(fields: [ticketId], references: [id], onDelete: Cascade)
  author User   @relation(fields: [authorId], references: [id])
  @@index([ticketId, createdAt])
}

model TicketStatusHistory {
  id         Int           @id @default(autoincrement())
  ticketId   Int
  oldStatus  TicketStatus?
  newStatus  TicketStatus
  changedBy  Int
  createdAt  DateTime      @default(now())
  ticket  Ticket @relation(fields: [ticketId], references: [id], onDelete: Cascade)
  changer User   @relation(fields: [changedBy], references: [id])
  @@index([ticketId, createdAt])
}

model AuditLog {
  id         Int      @id @default(autoincrement())
  actorId    Int?
  action     String   @db.VarChar(64)   // значения из AuditAction в коде
  entityType String   @db.VarChar(64)
  entityId   String?  @db.VarChar(64)
  metadata   Json?
  ipAddress  String?  @db.VarChar(64)
  createdAt  DateTime @default(now())
  actor User? @relation(fields: [actorId], references: [id])
  @@index([entityType, entityId])
  @@index([actorId, createdAt])
}

model ProcessedWebhook {
  id              Int      @id @default(autoincrement())
  externalEventId String   @unique @db.VarChar(200)
  createdAt       DateTime @default(now())
  @@index([createdAt])
}

model UserSession {
  userId    Int          @id
  state     SessionState @default(IDLE)
  draft     Json?        // {branchId, room, description}
  updatedAt DateTime     @updatedAt
  user User @relation(fields: [userId], references: [id], onDelete: Cascade)
}

model AdminActivationCode {
  id          Int       @id @default(autoincrement())
  codeHash    String    @unique @db.VarChar(64)  // SHA-256, сам код не хранится
  role        Role      @default(ADMIN)
  createdById Int?
  usedById    Int?
  expiresAt   DateTime
  usedAt      DateTime?
  createdAt   DateTime  @default(now())
  createdBy User? @relation("CodeCreator", fields: [createdById], references: [id])
  usedBy    User? @relation("CodeUser",    fields: [usedById],    references: [id])
}
```

Замечания:
- `maxUserId` — `BigInt`, потому что id в MAX могут выйти за int32. Нужна сериализация BigInt в логах.
- `number` через второй `autoincrement()` в одной модели Prisma не поддерживает. В миграции будет отдельный `SEQUENCE` с `DEFAULT nextval(...)`, поле остаётся `Int @unique @default(dbgenerated(...))`. Это решу при реализации.
- Для атомарного принятия добавим partial CHECK в SQL-миграции: `status='NEW' ⇒ assignedAdminId IS NULL`.

## 5. docker-compose.yml

```yaml
name: max-helpdesk

services:
  db:
    image: postgres:16-alpine
    restart: unless-stopped
    env_file: .env
    volumes:
      - pgdata:/var/lib/postgresql/data
    networks: [internal]
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U $${POSTGRES_USER} -d $${POSTGRES_DB}"]
      interval: 10s
      timeout: 5s
      retries: 5
    # ports: нет

  app:
    build: .
    restart: unless-stopped
    env_file: .env
    depends_on:
      db:
        condition: service_healthy
    networks: [internal]
    stop_grace_period: 30s
    read_only: true
    tmpfs: [/tmp]
    cap_drop: [ALL]
    security_opt: ["no-new-privileges:true"]
    healthcheck:
      test: ["CMD", "node", "-e", "fetch('http://127.0.0.1:3000/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"]
      interval: 15s
      timeout: 5s
      retries: 5
      start_period: 20s
    # expose только внутри сети, ports: нет

  nginx:
    image: nginx:1.27-alpine
    restart: unless-stopped
    depends_on:
      app:
        condition: service_healthy
    ports:
      - "443:443"
    volumes:
      - ./nginx/nginx.conf:/etc/nginx/nginx.conf:ro
      - ./nginx/conf.d:/etc/nginx/conf.d:ro
      - ./certs:/etc/nginx/certs:ro
      - nginx-logs:/var/log/nginx
    networks: [internal]
    healthcheck:
      test: ["CMD", "wget", "-qO-", "--no-check-certificate", "https://127.0.0.1/nginx-health"]
      interval: 30s
      timeout: 5s
      retries: 3

networks:
  internal: {}      # app и db наружу не публикуются

volumes:
  pgdata:
  nginx-logs:
```

- Миграции: отдельная одноразовая команда `docker compose run --rm app npx prisma migrate deploy`. В production-образ попадает Prisma CLI (в `dependencies`), `db push` не используется.
- Nginx наружу отдаёт только `POST /webhook/max` и `GET /nginx-health`, остальное получает 404. `/health` приложения наружу не торчит. Лимит тела 64 КБ, `limit_req`, security headers, таймауты 10 с.
- Dockerfile: стадии `deps → build → runtime` на `node:22-bookworm-slim`, `npm ci --omit=dev` в runtime, `USER node`, `prisma generate` в build.
- Сеть `internal` имеет выход наружу, это нужно, чтобы app ходил в `platform-api2.max.ru`. Полностью `internal: true` её сделать нельзя, иначе бот не сможет отправлять сообщения.

## 6. Схема обработки webhook

1. MAX → `POST /webhook/max` с заголовком `X-Max-Bot-Api-Secret`.
2. Nginx: лимит размера, rate limit, проксирование.
3. Fastify: constant-time сверка секрета. Не совпал → 401.
4. Zod разбирает Update. Неизвестные типы → 200 и игнор.
5. Строится `externalEventId`, затем `INSERT ... ON CONFLICT DO NOTHING`. Дубль → 200.
6. Загружаем или создаём `User` по `maxUserId`, обновляем `lastSeenAt`. Если `isActive=false` → отказ и `ACCESS_DENIED`.
7. Роутер: `bot_started` → меню; `message_callback` → разбор payload → handler → service; `message_created` → смотрим `UserSession.state` (ввод кабинета, описания, комментария, номера заявки, кода активации).
8. Service: проверка прав → транзакция (данные + история + аудит) → после коммита уведомления.
9. Для callback обязательно вызываем `POST /answers`, экран обновляем правкой сообщения (`PUT /messages`) или новым сообщением.
10. 200 OK.

## 8. Решения после ответов заказчика (имеют приоритет над разделами выше)

- **Домена нет, есть только внешний IP → режим по умолчанию `MAX_MODE=polling` (long polling).** Webhook MAX требует доверенный сертификат с совпадающим доменом, для голого IP это не гарантируется. Long polling работает только исходящими соединениями: порт 443 открывать не нужно, Nginx и сертификат не нужны, поверхность атаки минимальна (важно для медучреждения). Это отклонение от ТЗ (там webhook) из-за ограничения инфраструктуры.
- Код обработки общий: `update-router` получает Update из polling-цикла SDK или из роута `POST /webhook/max`. Webhook-режим остаётся в коде и включается `MAX_MODE=webhook` позже, если появится домен. Nginx в compose переносится в профиль `webhook` (`docker compose --profile webhook up -d`).
- Дедупликация и `ProcessedWebhook` остаются (защита от повторной доставки в обоих режимах).
- В `docker-compose` в режиме polling остаются только `app` и `db`, оба без `ports`. App-контейнеру нужен только исходящий доступ к `platform-api2.max.ru`.
- **Superadmin задаётся один раз по MAX-идентификатору:** переменная `SUPERADMIN_MAX_USER_ID` в `.env`. При старте выполняется upsert пользователя с ролью `SUPERADMIN` (`ADMIN_CREATED` в аудит). Другого пути стать superadmin нет. Кодов активации для superadmin нет. Админов дальше добавляет superadmin через `AdminActivationCode`.
  - Нюанс: в личном диалоге с ботом `user_id` и `chat_id` разные числа. Использую `user_id`. Чтобы узнать свой ID, бот отвечает на `/myid` значениями user_id и chat_id (команда работает у всех, ничего не раскрывает).
- **Филиалы (seed):** «Воровского», «50 лет ВЛКСМ», «Строитель». Редактирует superadmin позже, пока через `prisma/seed.ts`.

## 7. Что мне нужно от вас до старта реализации

1. **Публичный домен и сертификат.** Будет ли у машины домен, открытый порт 443 из интернета и сертификат от доверенного УЦ? Без этого webhook в MAX не зарегистрировать. Если нет, предлагаю fallback на long polling через флаг `MAX_MODE=polling`.
2. **Список филиалов** для seed (или добавлю заглушки).
3. **Первый superadmin:** подойдёт скрипт `create-superadmin.ts`, который выдаёт код активации?
4. Согласны с дополнительными таблицами `UserSession` и `AdminActivationCode`?
5. Первое действие после вашего «ок»: поднять бота локально и залогировать реальные Update (`bot_started`, `message_created`, `message_callback`), чтобы подтвердить поля для дедупликации и формат callback.
