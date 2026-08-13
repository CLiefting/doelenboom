#!/bin/bash
# Start Docker Desktop als die nog niet draait, wacht erop, en start dan de app.
set -e

if ! docker info >/dev/null 2>&1; then
  echo "Docker daemon niet actief — Docker Desktop wordt gestart..."
  open -a Docker --background
  while ! docker info >/dev/null 2>&1; do
    sleep 1
  done
  echo "Docker is klaar."
fi

cd "$(dirname "$0")"
docker compose up --build
