#!/bin/bash
set -e
mkdir -p "$HOME"
cd "$HOME"
exec ttyd -p 7681 -W -c "admin:${ACCESS_PASSWORD:?ACCESS_PASSWORD is required}" bash
