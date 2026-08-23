#!/bin/bash
set -e
mkdir -p "$HOME"
cd "$HOME"

# Warm the page cache for the installed CLI. Measured on claude-code, whose 331 MB binary cost
# 28.3s on the first exec after a boot (27.8s of it I/O wait) and 0.2s once cached. codex has the
# same shape: `command -v codex` is a 7 KB shim, and behind it sit a 251 MB vendor binary plus a
# 51 MB helper. The cost recurs after EVERY boot, not just the first ever.
#
# In the background, and before ttyd rather than after: reading it synchronously would push the
# first response past the platform's health-check window, and a template that fails its health
# check gets rolled back (QA.md). Backgrounded, the read overlaps the seconds a user spends
# opening the URL and typing the password.
#
# The whole global tree rather than one path, because the large files are vendored several levels
# down. tar reads every byte with one process and writes nothing.
# Leaves one zombie: ttyd is PID 1 and does not reap. Costs a PID slot, nothing else.
( tar -cf /dev/null -C "$(npm root -g)" . 2>/dev/null & )

exec ttyd -p 7681 -W -c "admin:${ACCESS_PASSWORD:?ACCESS_PASSWORD is required}" bash
