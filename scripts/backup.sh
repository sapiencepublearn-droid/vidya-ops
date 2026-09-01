#!/usr/bin/env bash
# Nightly logical backup. Small dataset (5 employees), so a full pg_dump
# every night is simpler and more reliable than PITR, and restores in
# seconds. Revisit if the database passes a few GB.
set -Eeuo pipefail

: "${ADMIN_DATABASE_URL:?ADMIN_DATABASE_URL is required}"
BACKUP_DIR="${BACKUP_DIR:-/var/backups/crm}"
RETAIN_DAYS="${BACKUP_RETAIN_DAYS:-30}"
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
OUT="${BACKUP_DIR}/crm-${STAMP}.dump"

mkdir -p "$BACKUP_DIR"

# -Fc is the custom format: compressed, and restorable table by table.
pg_dump --dbname="$ADMIN_DATABASE_URL" --format=custom --no-owner --file="$OUT"

# Integrity marker so a truncated file is detected before it is trusted.
sha256sum "$OUT" > "${OUT}.sha256"

if [[ -n "${BACKUP_GPG_RECIPIENT:-}" ]]; then
  gpg --batch --yes --encrypt --recipient "$BACKUP_GPG_RECIPIENT" "$OUT"
  shred -u "$OUT"
  OUT="${OUT}.gpg"
fi

if [[ -n "${BACKUP_S3_URI:-}" ]]; then
  aws s3 cp "$OUT" "${BACKUP_S3_URI}/" --sse AES256
  aws s3 cp "${OUT%.gpg}.sha256" "${BACKUP_S3_URI}/"
fi

find "$BACKUP_DIR" -name 'crm-*.dump*' -mtime "+${RETAIN_DAYS}" -delete

echo "backup complete: $OUT ($(du -h "$OUT" | cut -f1))"
