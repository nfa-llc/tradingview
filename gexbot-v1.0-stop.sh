#!/usr/bin/env bash
# Linux maintenance/recovery entry point for the shared gexbot package.
set -u

ROOT_DIR="$(CDPATH= cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
exec "$ROOT_DIR/platform/linux/stop.sh" "$@"
