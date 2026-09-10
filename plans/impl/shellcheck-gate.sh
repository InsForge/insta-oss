#!/bin/sh
# Run the widened CI shellcheck gate exactly as ci.yml does, so a local check matches the gate.
set -e
cd "$(dirname "$0")/../.."
shellcheck -s sh install.sh e2e/lib.sh e2e/local-smoke.sh e2e/server-smoke.sh
echo "shellcheck gate clean"
