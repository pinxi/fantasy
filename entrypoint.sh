#!/bin/bash
# Boot order: migrations first (worker/CLI owns them), then worker (cron +
# catch-up sweep) in the background and web in the foreground path. If either
# process dies the container exits and Fly restarts the machine.
#
# HOLD=1 parks the machine without touching the database — used once during
# initial provisioning to upload the local archive onto the volume safely.
set -e

if [ "$HOLD" = "1" ]; then
  echo "HOLD=1 — machine parked for data upload; no processes started"
  exec sleep infinity
fi

tsx() { node node_modules/tsx/dist/cli.mjs "$@"; }

tsx src/db/migrate.ts

tsx src/worker/index.ts &
WORKER_PID=$!

node_modules/.bin/next start -p 3000 -H 0.0.0.0 &
WEB_PID=$!

trap 'kill $WORKER_PID $WEB_PID 2>/dev/null; exit 0' TERM INT

wait -n $WORKER_PID $WEB_PID
echo "a process exited — shutting down for restart"
kill $WORKER_PID $WEB_PID 2>/dev/null
exit 1
