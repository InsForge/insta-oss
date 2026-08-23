#!/bin/bash
set -e
mkdir -p "$HOME"
cd "$HOME"

# Warm the page cache for the installed CLI. Measured on a fresh Fly machine: the first
# `claude --version` after a boot took 28.3s, of which 27.8s was I/O wait, because the shipped
# `claude` is a 331 MB native binary read cold off the device at roughly 12 MB/s. Once cached the
# same command takes 0.2s. It recurs after EVERY boot, not just the first ever.
#
# In the background, and before ttyd rather than after: reading it synchronously would push the
# first response past the platform's health-check window, and a template that fails its health
# check gets rolled back (QA.md). Backgrounded, the read overlaps the seconds a user spends
# opening the URL and typing the password.
#
# The whole global tree, not the resolved binary: codex's `command -v` target is a 7 KB shim in
# front of a 251 MB vendor binary, and pi has no single large file at all. tar reads every byte
# with one process and writes nothing.
( tar -cf /dev/null -C "$(npm root -g)" . 2>/dev/null & )

exec ttyd -p 7681 -W -c "admin:${ACCESS_PASSWORD:?ACCESS_PASSWORD is required}" bash
