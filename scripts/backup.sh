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

# ---------------------------------------------------------------- verify
# "The command exited 0" is not the same as "there is a usable backup".
# Each check below has to pass before this script reports success.
fail() { echo "BACKUP FAILED: $1" >&2; echo "{\"ok\":false,\"error\":\"$1\",\"at\":\"$(date -u +%FT%TZ)\"}" > "${BACKUP_DIR}/last-backup.json"; exit 1; }

[[ -f "$OUT" ]] || fail "backup file was not created"

SIZE=$(stat -c%s "$OUT" 2>/dev/null || stat -f%z "$OUT")
[[ "$SIZE" -gt 1024 ]] || fail "backup file is empty or truncated (${SIZE} bytes)"

if [[ -f "${OUT}.sha256" ]]; then
  sha256sum --check --status "${OUT}.sha256" || fail "checksum does not match"
fi

# Structural check: can pg_restore read the archive and see real tables?
if [[ "$OUT" != *.gpg ]]; then
  TABLES=$(pg_restore --list "$OUT" 2>/dev/null | grep -c 'TABLE DATA' || true)
  [[ "${TABLES:-0}" -gt 0 ]] || fail "archive is unreadable or contains no table data"
else
  TABLES="encrypted, not inspected"
fi

# A machine-readable record the health endpoint and the admin can read.
cat > "${BACKUP_DIR}/last-backup.json" <<JSON
{"ok":true,"file":"$(basename "$OUT")","bytes":${SIZE},"tables":"${TABLES}","at":"$(date -u +%FT%TZ)"}
JSON

echo "backup verified: $OUT (${SIZE} bytes, ${TABLES} tables with data)"
echo "NOTE: this validates the archive. Restore testing is separate:"
echo "      ./scripts/restore-verify.sh $OUT"
