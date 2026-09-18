#!/bin/bash
pgrep -f 'worker[d]' | xargs -r kill 2>/dev/null
pgrep -f 'bin/wrangle[r]' | xargs -r kill 2>/dev/null
sleep 1
