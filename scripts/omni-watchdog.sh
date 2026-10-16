#!/usr/bin/env bash
# Restart Omni when it stops answering.
#
# A server-side app can block Node's event loop (a runaway loop, a pathological
# layout). The process stays "active" and keeps its port, but answers nothing —
# and the glasses just sit there. This probes the API and, after two failures in
# a row, kills and restarts the service.
#
# Run it from a systemd timer every minute:
#   ~/.config/systemd/user/omni-watchdog.service   (Type=oneshot, ExecStart=this)
#   ~/.config/systemd/user/omni-watchdog.timer     (OnUnitActiveSec=1min)
set -u
ROOT="${OMNI_ROOT:-$HOME/projects/omnieven}"
URL="${OMNI_HEALTH_URL:-http://127.0.0.1:${PORT:-7788}/api/status}"
UNIT="${OMNI_UNIT:-omni}"
STATE="${XDG_RUNTIME_DIR:-/tmp}/omni-watchdog.fail"
TOKEN="${OMNI_TOKEN:-$(cat "$ROOT/data/token" 2>/dev/null)}"

if curl -fsS -m 8 -H "Authorization: Bearer $TOKEN" "$URL" >/dev/null 2>&1; then
  rm -f "$STATE"
  exit 0
fi

if [ -f "$STATE" ]; then
  echo "omni did not answer twice in a row — restarting"
  systemctl --user kill -s KILL "$UNIT" 2>/dev/null   # a wedged process ignores SIGTERM
  sleep 2
  systemctl --user start "$UNIT"
  rm -f "$STATE"
else
  echo "omni did not answer — will restart if it fails again"
  : > "$STATE"
fi
