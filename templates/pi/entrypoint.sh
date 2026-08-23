#!/bin/bash
set -e
mkdir -p "$HOME"
cd "$HOME"

# Warm the page cache for the installed CLI. Measured on claude-code, whose 331 MB binary cost
# 28.3s on the first exec after a boot (27.8s of it I/O wait) and 0.2s once cached. The cost
# recurs after EVERY boot, not just the first ever.
#
# pi is the weakest case of the three and is warmed anyway, for one reason: it has NO single large
# file, so its 163 MB is spread over many small JS modules. Per byte that is slower to read than
# one sequential 331 MB file, not faster, so leaving it out would be a guess in the wrong
# direction. Whether it wins as much has not been measured on pi itself.
#
# In the background, and before ttyd rather than after: reading it synchronously would push the
# first response past the platform's health-check window, and a template that fails its health
# check gets rolled back (QA.md). tar reads every byte with one process and writes nothing.
# Leaves one zombie: ttyd is PID 1 and does not reap. Costs a PID slot, nothing else.
( tar -cf /dev/null -C "$(npm root -g)" . 2>/dev/null & )

exec ttyd -p 7681 -W -c "admin:${ACCESS_PASSWORD:?ACCESS_PASSWORD is required}" bash
