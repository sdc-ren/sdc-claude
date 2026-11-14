#!/bin/sh
# Kept for older instructions: the reaper is installed by reaper.mjs on macOS, Linux and Windows.
exec node "$(cd "$(dirname "$0")" && pwd)/reaper.mjs" install
