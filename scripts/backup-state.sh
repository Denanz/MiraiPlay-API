#!/usr/bin/env bash
# Snapshots the miraihub-state Docker volume (screenshots, watch progress,
# ratings, diary, cache) to a timestamped tarball outside Docker, so a
# container/volume/disk loss doesn't wipe personal data with no way back.
# Prunes snapshots beyond the retention count. Read-only mount — never
# touches the live volume.
set -euo pipefail

BACKUP_DIR="/home/denanz/backups/miraihub-state"
RETENTION=14
VOLUME="miraihub_miraihub-state"
STAMP="$(date +%Y%m%d-%H%M%S)"

mkdir -p "$BACKUP_DIR"

docker run --rm \
  -v "$VOLUME:/data:ro" \
  -v "$BACKUP_DIR:/backup" \
  alpine \
  tar czf "/backup/state-$STAMP.tar.gz" -C /data .

# Keep only the newest $RETENTION archives.
ls -1t "$BACKUP_DIR"/state-*.tar.gz 2>/dev/null | tail -n +$((RETENTION + 1)) | xargs -r rm -f

echo "Backed up to $BACKUP_DIR/state-$STAMP.tar.gz"
du -sh "$BACKUP_DIR"/state-*.tar.gz 2>/dev/null | tail -"$RETENTION"
