#!/usr/bin/env bash
# Rebuilds and redeploys the MiraiHub backend container. Safe to re-run —
# `docker compose` diffs against the running container and only recreates it
# when the image actually changed. The `name: miraihub` pin in
# docker-compose.yml keeps this pointed at the existing data volume
# (miraihub_miraihub-state) regardless of what this directory is called.
set -euo pipefail

cd "$(dirname "$0")/.."

echo "== typecheck =="
npx tsc --noEmit

echo "== build + redeploy container =="
docker compose up -d --build

echo "== health =="
sleep 2
docker inspect miraihub --format 'status={{.State.Status}} health={{.State.Health.Status}} startedAt={{.State.StartedAt}}'
