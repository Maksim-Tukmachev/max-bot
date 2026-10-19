# MAX Helpdesk — бот заявок для сотрудников

Внутренний бот для мессенджера MAX: сотрудники создают заявки (филиал → кабинет → описание), администраторы принимают их в работу, меняют статусы, комментируют и передают друг другу. Всё работает в Docker на одной машине под РЕД ОС.

**Стек:** Node.js 22 + TypeScript (strict), Fastify, PostgreSQL 16, Prisma, Zod, Docker Compose. Официальный SDK MAX: [`@maxhub/max-bot-api`](https://github.com/max-messenger/max-bot-api-client-ts).

> ⚠️ Бот **не предназначен** для передачи медицинских и персональных данных пациентов. Пользователю на экране ввода описания показывается предупреждение, полей «пациент / диагноз / СНИЛС / полис / карта» нет.

## Содержание
1. [Режимы работы: polling и webhook](#1-режимы-работы)
2. [Требования к машине](#2-требования-к-машине)
3. [Установка Docker на РЕД ОС](#3-установка-docker)
4. [Развёртывание](#4-развёртывание)
5. [Роли и первый запуск](#5-роли-и-первый-запуск)
6. [Эксплуатация](#6-эксплуатация)
7. [Обновление](#7-обновление)
8. [Backup и restore](#8-backup-и-restore)
9. [Firewall](#9-firewall)
10. [Режим webhook (Nginx + HTTPS)](#10-режим-webhook)
11. [Разработка и тесты](#11-разработка-и-тесты)
12. [Безопасность](#12-безопасность)

---

## 1. Режимы работы

| | `MAX_MODE=polling` (по умолчанию) | `MAX_MODE=webhook` |
|---|---|---|
| Как бот получает события | сам опрашивает MAX (long polling) | MAX шлёт POST на ваш URL |
| Домен и сертификат | **не нужны** | нужны: HTTPS:443, сертификат от доверенного УЦ, домен = CN/SAN |
| Входящие порты на машине | **не нужны** | 443 из интернета |
| Контейнеры | `app`, `db` | `app`, `db`, `nginx` |

В ТЗ был указан webhook. Документация MAX требует для него публичный домен и доверенный сертификат (самоподписанные не поддерживаются). Если домена нет и есть только внешний IP, используется long polling: бот делает только исходящие соединения к `platform-api2.max.ru`, ничего публиковать наружу не нужно. Код webhook-режима готов и включается переменной `MAX_MODE=webhook` — см. [раздел 10](#10-режим-webhook).

## 2. Требования к машине

- РЕД ОС 7.3 / 8 (x86_64), 2 vCPU, 2 ГБ RAM, 20 ГБ диска (БД и backup растут медленно).
- Исходящий доступ по HTTPS (443) к `platform-api2.max.ru`.
- Права `sudo`, синхронизация времени (chrony) — важна для TLS и меток времени.
- Docker Engine 24+ и Docker Compose v2 (`docker compose`, не `docker-compose`).

## 3. Установка Docker

По официальной инструкции РЕД ОС 7.3 ([Установка и настройка docker](https://redos.red-soft.ru/base/redos-7_3/7_3-administation/7_3-containers/7_3-docker-install/); в ней версии `docker-ce` / `docker-ce-cli` 28.1.1):

```bash
sudo dnf install -y docker-ce docker-ce-cli
sudo systemctl enable docker --now
systemctl status docker      # должно быть active (running)
docker info
```

Работа без `sudo`: пользователь добавляется в группу `docker` (создаётся при установке; группа даёт права, эквивалентные root, — только для доверенных администраторов). После команды нужно выйти из сессии и зайти снова:

```bash
sudo usermod -aG docker $USER
```

**Docker Compose.** В статье РЕД ОС плагин `docker compose` не описан. Проверьте:

```bash
docker compose version
```

Если команда не найдена, поищите пакет в репозиториях (`sudo dnf search docker-compose`) и установите его (`docker-compose-plugin`, если он есть). Проект рассчитан на Compose v2 — команду `docker compose` (через пробел).

**Если Docker Hub недоступен** (образы `node`, `postgres` не скачиваются), РЕД ОС рекомендует настроить зеркало: в `/etc/docker/daemon.json` добавьте

```json
{ "registry-mirrors": ["https://mirror.gcr.io/"] }
```

и выполните `sudo systemctl daemon-reload && sudo systemctl restart docker`.

Проверка:

```bash
docker --version
docker compose version
docker run --rm hello-world
```

## 4. Развёртывание

```bash
sudo mkdir -p /opt/max-helpdesk
sudo chown $USER: /opt/max-helpdesk
git clone <URL_РЕПОЗИТОРИЯ> /opt/max-helpdesk
cd /opt/max-helpdesk
```

### 4.1 Бот в MAX
Создайте бота в кабинете разработчика MAX ([dev.max.ru](https://dev.max.ru)) и получите токен.

### 4.2 Файл `.env`

```bash
cp .env.example .env
chmod 600 .env
```

Заполните значения. Пароль БД сгенерируйте и **используйте один и тот же** в `POSTGRES_PASSWORD` и в `DATABASE_URL`:

```bash
openssl rand -hex 24      # пароль БД (hex — без спецсимволов, безопасно для URL)
```

| Переменная | Назначение |
|---|---|
| `POSTGRES_DB`, `POSTGRES_USER`, `POSTGRES_PASSWORD` | БД; инициализируют контейнер `db` при первом старте |
| `DATABASE_URL` | `postgresql://USER:PASSWORD@db:5432/DB?schema=public` |
| `MAX_BOT_TOKEN` | токен бота MAX |
| `MAX_MODE` | `polling` (по умолчанию) или `webhook` |
| `MAX_WEBHOOK_DOMAIN`, `MAX_WEBHOOK_SECRET` | только для webhook; секрет 5–256 символов `[A-Za-z0-9_-]` (`openssl rand -hex 32`) |
| `SUPERADMIN_MAX_USER_ID` | MAX `user_id` единственного superadmin |

`.env` в Git не попадает (`.gitignore`). Токены и пароли в логи не пишутся.

> Меняли пароль БД после первого запуска? Он уже записан в volume `pgdata`. Либо смените его командой `ALTER USER` внутри БД, либо пересоздайте volume (`docker compose down -v` — **удалит данные**).

### 4.3 Как узнать свой `user_id`
1. Запустите бота без `SUPERADMIN_MAX_USER_ID` (шаги ниже).
2. Напишите боту команду `/myid` — он ответит вашим `user_id` и `chat_id`.
3. Впишите `user_id` в `.env` и перезапустите: `docker compose restart app`.

`user_id` и `chat_id` в личном диалоге — разные числа; для роли используется **`user_id`**.

### 4.4 Запуск

```bash
docker compose build
docker compose up -d db
docker compose run --rm app npx prisma migrate deploy   # миграции (никогда не db push)
docker compose run --rm app node dist/prisma/seed.js    # филиалы: Воровского, 50 лет ВЛКСМ, Строитель
docker compose up -d
```

Проверка:

```bash
docker compose ps                  # app и db в статусе healthy
docker compose logs -f app         # "http server started", "superadmin ensured"
docker compose exec app node -e "fetch('http://127.0.0.1:3000/health').then(r=>r.text()).then(console.log)"
# {"status":"ok"}  — одновременно проверяет соединение с PostgreSQL
```

Напишите боту в MAX — должно появиться меню.

Список филиалов правится в [`prisma/seed.ts`](prisma/seed.ts) (повторный запуск seed безопасен) либо SQL-командой в БД.

## 5. Роли и первый запуск

| Роль | Как назначается |
|---|---|
| `USER` | автоматически при первом сообщении боту |
| `ADMIN` | superadmin создаёт одноразовый код (меню «🔑 Код активации»); сотрудник отправляет боту `/activate КОД` |
| `SUPERADMIN` | **только** через `SUPERADMIN_MAX_USER_ID` в `.env` (при старте приложения) |

- Роль всегда берётся из БД по MAX `user_id` и проверяется при каждом действии.
- Код активации: 12 символов, действует 24 часа, одноразовый, в БД хранится только его SHA-256. Сообщение с кодом бот пытается удалить из переписки.
- Общего пароля администратора нет. Отключить администратора: меню «👥 Администраторы».
- Все критические действия пишутся в таблицу `AuditLog` (`TICKET_CREATED`, `TICKET_ACCEPTED`, `TICKET_STATUS_CHANGED`, `TICKET_TRANSFERRED`, `TICKET_COMMENT_CREATED`, `TICKET_CLOSED`, `ADMIN_ACTIVATED`, `ADMIN_CREATED`, `ADMIN_DISABLED`, `ACCESS_DENIED`).

Просмотр аудита:

```bash
docker compose exec db sh -c 'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -c "SELECT \"createdAt\", action, \"actorId\", \"entityId\" FROM \"AuditLog\" ORDER BY id DESC LIMIT 30"'
```

## 6. Эксплуатация

```bash
docker compose up -d              # запустить всё
docker compose down               # остановить и удалить контейнеры (данные в volume сохраняются)
docker compose ps                 # состояние
docker compose logs -f app        # логи приложения (JSON)
docker compose restart app        # перезапуск приложения
docker compose pull               # обновить образы db/nginx
docker compose build              # пересобрать образ приложения
docker compose up -d --build      # пересобрать и перезапустить
```

Логи структурированные (JSON, pino). Удобный просмотр: `docker compose logs app | jq`. Ротация логов Docker — в `/etc/docker/daemon.json`:

```json
{ "log-driver": "json-file", "log-opts": { "max-size": "20m", "max-file": "5" } }
```

После правки — `sudo systemctl restart docker`.

Контейнеры стартуют автоматически после перезагрузки сервера (`restart: unless-stopped` + `systemctl enable docker`). При остановке приложение корректно завершается по `SIGTERM` (перестаёт принимать запросы, ждёт активные, закрывает соединение с БД; до 30 с).

## 7. Обновление

```bash
cd /opt/max-helpdesk
scripts/backup.sh                                       # 1. резервная копия
git pull                                                # 2. новый код
docker compose build                                    # 3. новый образ
docker compose run --rm app npx prisma migrate deploy   # 4. миграции
docker compose up -d                                    # 5. перезапуск
docker compose logs --tail 50 app
```

## 8. Backup и restore

Backup — `pg_dump` в `./backups/max-helpdesk-YYYY-MM-DD-HH-MM.sql.gz`, файлы старше 14 дней удаляются (`KEEP_DAYS=30 scripts/backup.sh` — изменить срок).

```bash
scripts/backup.sh
```

### Ежедневно через cron (РЕД ОС)

```bash
sudo systemctl enable --now crond
crontab -e
```

```cron
# каждый день в 03:00
0 3 * * * /opt/max-helpdesk/scripts/backup.sh >> /opt/max-helpdesk/backups/backup.log 2>&1
```

Пользователь cron должен быть в группе `docker`. Проверьте вручную, что `scripts/backup.sh` отрабатывает от этого пользователя. **Копируйте `backups/` на другой носитель или хост** — backup на той же машине не защитит от потери диска. Дампы содержат тексты заявок: храните их с ограниченными правами (скрипт создаёт файлы с `umask 077`).

### Restore

```bash
scripts/restore.sh backups/max-helpdesk-2026-10-07-03-00.sql.gz
```

Скрипт остановит `app`, пересоздаст базу из дампа и запустит `app` обратно. Требует подтверждения (`yes`). Рекомендуется периодически проверять восстановление на тестовой машине.

## 9. Firewall

**Режим polling:** входящие подключения не нужны. Закрыто всё, кроме SSH:

```bash
sudo systemctl enable --now firewalld
sudo firewall-cmd --permanent --add-service=ssh
sudo firewall-cmd --reload
sudo firewall-cmd --list-all
```

Порты PostgreSQL (5432) и приложения (3000) не публикуются Docker-ом вообще — убедитесь: `docker compose ps` не показывает проброшенных портов у `db` и `app`.

**Режим webhook:** дополнительно откройте 443:

```bash
sudo firewall-cmd --permanent --add-port=443/tcp
sudo firewall-cmd --reload
```

> Docker сам управляет iptables для опубликованных портов и обходит правила firewalld для них. Поэтому в `docker-compose.yml` публикуется только порт 443 у `nginx` (и только в профиле `webhook`).

Если включён SELinux, для bind-mount каталогов `nginx/`, `certs/` может потребоваться суффикс `:z` в томах compose.

## 10. Режим webhook

Нужны: публичный домен, указывающий на машину; открытый 443; сертификат доверенного УЦ (Let's Encrypt или российский УЦ/Минцифры) с **полной цепочкой**.

1. Положите сертификат в `./certs/fullchain.pem` и ключ в `./certs/privkey.pem` (`chmod 600 certs/privkey.pem`). Каталог не попадает в Git.
2. В `.env`:
   ```
   MAX_MODE=webhook
   MAX_WEBHOOK_DOMAIN=bot.example.ru
   MAX_WEBHOOK_SECRET=<openssl rand -hex 32>
   ```
3. Запуск вместе с Nginx:
   ```bash
   docker compose --profile webhook up -d --build
   ```
4. При старте приложение само регистрирует подписку (`POST /subscriptions`) на `https://<домен>/webhook/max` с секретом; MAX присылает его в заголовке `X-Max-Bot-Api-Secret`, приложение сверяет его в постоянное время. Запросы с неверным секретом отвергаются.
5. Проверка сертификата снаружи: `curl -vI https://bot.example.ru/nginx-health`.

Nginx пропускает наружу только `POST /webhook/max`, всё остальное — 404. Лимит тела 64 КБ, rate limit, таймауты, заголовки безопасности, access/error логи в volume `nginx-logs` (`docker compose logs nginx`).

Обновление сертификата — замените файлы и выполните `docker compose --profile webhook restart nginx`.

Дубли событий (MAX повторяет доставку до 10 раз при ошибках) отсекаются таблицей `ProcessedWebhook`; записи старше 7 дней удаляются автоматически.

## 11. Разработка и тесты

```bash
npm ci
cp .env.example .env     # и заполнить; для локальной БД: DATABASE_URL=postgresql://...@localhost:5432/...
npm run typecheck
npm test                 # unit-тесты; интеграционные пропускаются без TEST_DATABASE_URL
```

Интеграционные тесты (создание заявки, чужие заявки, принятие, **одновременное принятие 8 админами**, статусы, права, дедупликация, FSM, webhook-секрет) требуют реальный PostgreSQL:

```bash
docker run -d --name helpdesk-test-db -e POSTGRES_USER=test -e POSTGRES_PASSWORD=test -e POSTGRES_DB=helpdesk_test -p 127.0.0.1:55432:5432 postgres:16-alpine
export TEST_DATABASE_URL="postgresql://test:test@127.0.0.1:55432/helpdesk_test?schema=public"
DATABASE_URL="$TEST_DATABASE_URL" npx prisma migrate deploy
npm test
```

Структура: `MAX → handler → service → repository → Prisma → PostgreSQL`. Обработчики не содержат SQL; права проверяются в сервисах; сообщения MAX отправляет `NotificationService` через интерфейс `Messenger` (в тестах подменяется заглушкой). Допустимые переходы статусов — в [`src/domain/ticket-transitions.ts`](src/domain/ticket-transitions.ts).

Полное описание архитектуры: [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

## 12. Безопасность

- Наружу — только 443 у Nginx (и только в режиме webhook); PostgreSQL и приложение портов не публикуют; сеть `internal`.
- Контейнер приложения: не root, `read_only`, `cap_drop: ALL`, `no-new-privileges`; нет privileged, host network, `docker.sock`.
- Принятие заявки — условный `UPDATE ... WHERE status='NEW' AND assignedAdminId IS NULL` в транзакции PostgreSQL + `CHECK`-ограничение в БД: двум админам заявка достаться не может.
- Payload кнопок разбирается строгим парсером и не считается доверенным: права и состояние заявки проверяются на сервере при каждом нажатии. Чужая заявка для пользователя неотличима от несуществующей, попытка пишется в аудит.
- Валидация (Zod): кабинет ≤ 100, описание ≤ 2000, комментарий ≤ 2000 символов, пустые значения не принимаются. Rate limit: HTTP (на IP) и на пользователя (30 действий/мин).
- Ошибки backend пользователю не показываются — общее сообщение; детали только в JSON-логе без токенов, секретов и `DATABASE_URL`.
- Не публикуйте `.env`, backup и содержимое `certs/`.
