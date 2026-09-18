#!/bin/bash
# a law-firm client on port 8792 (same local database as ./dev.sh; wipe between suites)
cd /home/claude/fsb-portal
LOG=/tmp/claude-0/-home-claude/92837ed5-ecd6-5120-8fa6-c10a44626d6e/scratchpad/devfirm.log
nohup npx wrangler dev --port 8792 --var MAIL_DISABLED:1 --var CLIENT_TYPE:firm --var LENDER_NAME:"Harlan & Voss, Attorneys" --var LENDER_TAGLINE:"Estate and trust practice" > "$LOG" 2>&1 &
for i in $(seq 1 45); do sleep 1; curl -s -m 2 http://127.0.0.1:8792/api/health 2>/dev/null | grep -q ok && { echo "firm dev up"; exit 0; }; done
echo "firm dev failed"; tail -20 "$LOG"; exit 1
