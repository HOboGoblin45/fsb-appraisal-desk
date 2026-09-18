#!/bin/bash
# local demo environment on port 8788 (wrangler reads .dev.vars.demo for --env demo)
cd /home/claude/fsb-portal
LOG=/tmp/claude-0/-home-claude/92837ed5-ecd6-5120-8fa6-c10a44626d6e/scratchpad/devdemo.log
nohup npx wrangler dev --env demo --port 8788 > "$LOG" 2>&1 &
for i in $(seq 1 45); do sleep 1; curl -s -m 2 http://127.0.0.1:8788/api/health 2>/dev/null | grep -q ok && { echo "demo dev up"; exit 0; }; done
echo "demo dev failed"; tail -20 "$LOG"; exit 1
