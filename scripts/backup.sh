#!/usr/bin/env bash
# Резервная копия БД: ./backups/max-helpdesk-YYYY-MM-DD-HH-MM.sql.gz
# Запуск из любого каталога: /opt/max-helpdesk/scripts/backup.sh
set -euo pipefail

PROJECT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BACKUP_DIR="${BACKUP_DIR:-$PROJECT_DIR/backups}"
KEEP_DAYS="${KEEP_DAYS:-14}"

cd "$PROJECT_DIR"
# shellcheck disable=SC1091
set -a; . ./.env; set +a

mkdir -p "$BACKUP_DIR"
umask 077
FILE="$BACKUP_DIR/max-helpdesk-$(date +%Y-%m-%d-%H-%M).sql.gz"
TMP="$FILE.partial"

# Пароль не передаётся в командной строке: pg_dump работает внутри контейнера db по локальному сокету.
docker compose exec -T db pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB" --no-owner --no-privileges | gzip -9 > "$TMP"

# Защита от пустого дампа
if [ "$(gzip -dc "$TMP" | wc -c)" -lt 100 ]; then
  rm -f "$TMP"
  echo "Backup failed: empty dump" >&2
  exit 1
fi
mv "$TMP" "$FILE"
find "$BACKUP_DIR" -name 'max-helpdesk-*.sql.gz' -type f -mtime +"$KEEP_DAYS" -delete
echo "Backup created: $FILE"
