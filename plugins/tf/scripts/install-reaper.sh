#!/bin/sh
# Install a launchd job that runs `resources.mjs reap` every 30 minutes (frees resources of tasks whose
# PRs are all merged/closed). Uninstall: launchctl unload <plist> && rm <plist>.
set -e
# Idle days before prune frees a task (default 7) and before an archived task is deleted (default 30):
#   TF_PRUNE_DAYS=10 TF_ARCHIVE_DAYS=30 sh install-reaper.sh
PRUNE_DAYS=${TF_PRUNE_DAYS:-7}
ARCHIVE_DAYS=${TF_ARCHIVE_DAYS:-30}
LABEL=ai.claude.task-flow-reap
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
NODE=$(command -v node)
GH_DIR=$(dirname "$(command -v gh)")
# The plugin lives in a versioned cache that moves on every update, so launchd runs a stable copy.
# Re-run this script after a plugin update to refresh the copy.
HERE=$(cd "$(dirname "$0")" && pwd)
mkdir -p "$HOME/Library/LaunchAgents" "$HOME/.claude/task-flow/reaper"
cp "$HERE/resources.mjs" "$HOME/.claude/task-flow/reaper/resources.mjs"
SCRIPT="$HOME/.claude/task-flow/reaper/resources.mjs"
cat > "$PLIST" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>$LABEL</string>
  <key>ProgramArguments</key><array><string>$NODE</string><string>$SCRIPT</string><string>reap</string></array>
  <key>StartInterval</key><integer>1800</integer>
  <key>RunAtLoad</key><true/>
  <key>EnvironmentVariables</key><dict>
    <key>PATH</key><string>$(dirname "$NODE"):$GH_DIR:/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin</string>
    <key>TF_PRUNE_DAYS</key><string>$PRUNE_DAYS</string>
    <key>TF_ARCHIVE_DAYS</key><string>$ARCHIVE_DAYS</string>
  </dict>
  <key>StandardOutPath</key><string>$HOME/.claude/task-flow/reap.out</string>
  <key>StandardErrorPath</key><string>$HOME/.claude/task-flow/reap.out</string>
</dict></plist>
EOF
launchctl unload "$PLIST" 2>/dev/null || true
launchctl load "$PLIST"
echo "installed $LABEL (every 30 min) → log: ~/.claude/task-flow/reap.log"
