#!/bin/bash
# e2e runner: kills strays by PID (never pattern-match, or we kill our own shell)
cd /home/bence/git/stroke-coach
for pid in $(pgrep -f 'http[.]server 8080'); do kill -9 "$pid" 2>/dev/null; done
sleep 1
node --test --test-timeout=90000 tests/e2e-browser.test.js > /tmp/e2e_run.log 2>&1
echo "exit=$?"
grep -E "E2E-DIAG|^(not )?ok|error: '[^']+'" /tmp/e2e_run.log | head -8
