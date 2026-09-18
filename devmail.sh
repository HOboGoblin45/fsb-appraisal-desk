#!/bin/bash
# Local dev server on port 8789 with delivery switched on against the test sink (test/sink.js on 8790).
# Same database as ./dev.sh; wipe .wrangler/state between suites.
cd /home/claude/fsb-portal
LOG=/tmp/claude-0/-home-claude/92837ed5-ecd6-5120-8fa6-c10a44626d6e/scratchpad/devmail.log
nohup npx wrangler dev --port 8789 \
  --var PUBLIC_URL:http://127.0.0.1:8789 \
  --var MAIL_HOOK_URL:http://127.0.0.1:8790/mail \
  --var MAIL_INBOUND:desk@fsb.apprifi.com \
  --var VENDOR_EMAIL:vendor@example.com \
  --var TWILIO_ACCOUNT_SID:ACtest000000000000000000000000000 \
  --var TWILIO_AUTH_TOKEN:testauthtoken0123456789abcdef \
  --var TWILIO_FROM:+13095550000 \
  --var TWILIO_API_BASE:http://127.0.0.1:8790 \
  > "$LOG" 2>&1 &
for i in $(seq 1 45); do sleep 1; curl -s -m 2 http://127.0.0.1:8789/api/health 2>/dev/null | grep -q ok && { echo "mail dev up"; exit 0; }; done
echo "mail dev failed"; tail -20 "$LOG"; exit 1
