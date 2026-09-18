#!/bin/bash
# start the local dev server in the background and wait for it
cd /home/claude/fsb-portal
LOG=/tmp/claude-0/-home-claude/92837ed5-ecd6-5120-8fa6-c10a44626d6e/scratchpad/dev.log
# MAIL_DISABLED keeps this copy in by-hand mode (the suites for that mode expect it); ./devmail.sh is the sending copy
nohup npx wrangler dev --port 8787 --var MAIL_DISABLED:1 > "$LOG" 2>&1 &
for i in $(seq 1 45); do sleep 1; curl -s -m 2 http://127.0.0.1:8787/api/health 2>/dev/null | grep -q ok && { echo "dev up"; exit 0; }; done
echo "dev failed"; tail -20 "$LOG"; exit 1
