#!/usr/bin/env bash
# Восстановление БД из дампа: scripts/restore.sh backups/max-helpdesk-2026-10-07-03-00.sql.gz
# ВНИМАНИЕ: текущие данные будут заменены.
set -euo pipefail

FILE="${1:-}"
if [ -z "$FILE" ] || [ ! -f "$FILE" ]; then
  echo "Использование: $0 <файл.sql.gz>" >&2
  exit 1
fi

PROJECT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$PROJECT_DIR"
# shellcheck disable=SC1091
set -a; . ./.env; set +a

read -r -p "Заменить базу $POSTGRES_DB данными из $FILE? Введите yes: " CONFIRM
[ "$CONFIRM" = "yes" ] || { echo "Отменено"; exit 1; }

docker compose stop app
docker compose exec -T db psql -U "$POSTGRES_USER" -d postgres -v ON_ERROR_STOP=1 \
  -c "DROP DATABASE IF EXISTS \"$POSTGRES_DB\" WITH (FORCE)" \
  -c "CREATE DATABASE \"$POSTGRES_DB\" OWNER \"$POSTGRES_USER\""
gzip -dc "$FILE" | docker compose exec -T db psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -v ON_ERROR_STOP=1 -q
docker compose start app
echo "Восстановлено из $FILE"
