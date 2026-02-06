#!/bin/bash
export PATH=/Users/macmini/.local/bin:/opt/homebrew/bin:$PATH
cd ~/mrtns-projects

SKIP_FILE=~/auto-fix-skip.txt
LOG=~/auto-fix.log
MAX_RUNTIME=1800  # 30 minutes max per run

# Create skip file if it doesn't exist
touch "$SKIP_FILE"

# Check if someone is already using claude
CLAUDE_PID=$(pgrep -f "claude -p")
if [ -n "$CLAUDE_PID" ]; then
  # Check how long it's been running
  ELAPSED=$(ps -o etimes= -p $CLAUDE_PID 2>/dev/null | tr -d ' ')
  if [ -n "$ELAPSED" ] && [ "$ELAPSED" -gt "$MAX_RUNTIME" ]; then
    echo "$(date): Claude PID $CLAUDE_PID stuck for ${ELAPSED}s (>${MAX_RUNTIME}s), killing" >> $LOG
    kill $CLAUDE_PID
    sleep 5
    # Force kill if still alive
    kill -9 $CLAUDE_PID 2>/dev/null
  else
    echo "$(date): Claude Code already running (${ELAPSED}s), skipping" >> $LOG
    exit 0
  fi
fi

# Get oldest open auto-fix issues
ISSUE_JSON=$(gh issue list --repo nicolasmertens/mrtns-projects --label auto-fix --state open --limit 5 --json number,title)

# Find first issue not in skip list
NUMBER=""
TITLE=""
for i in $(seq 0 4); do
  N=$(echo "$ISSUE_JSON" | jq -r ".[$i].number // empty")
  [ -z "$N" ] && break
  if grep -q "^$N$" "$SKIP_FILE"; then
    echo "$(date): Skipping #$N (in skip list)" >> $LOG
    continue
  fi
  NUMBER=$N
  TITLE=$(echo "$ISSUE_JSON" | jq -r ".[$i].title")
  break
done

if [ -z "$NUMBER" ]; then
  echo "$(date): No auto-fix issues found (or all skipped)" >> $LOG
  exit 0
fi

# Check how many times we've attempted this issue
ATTEMPTS=$(grep -c "Starting.*#$NUMBER" $LOG 2>/dev/null || echo 0)
if [ "$ATTEMPTS" -ge 3 ]; then
  echo "$(date): Issue #$NUMBER attempted $ATTEMPTS times, adding to skip list" >> $LOG
  echo "$NUMBER" >> "$SKIP_FILE"
  exit 0
fi

# Check if there's an existing auto-fix PR
EXISTING_PR=$(gh pr list --repo nicolasmertens/mrtns-projects --state open --json number,headRefName --jq '[.[] | select(.headRefName == "auto-fix-batch")] | .[0].number // empty')

if [ -n "$EXISTING_PR" ]; then
  echo "$(date): Adding fix for #$NUMBER to existing PR #$EXISTING_PR" >> $LOG
  git checkout auto-fix-batch
  git pull origin auto-fix-batch
else
  echo "$(date): Starting new batch with fix for #$NUMBER" >> $LOG
  git checkout main
  git pull
  git checkout -b auto-fix-batch 2>/dev/null || { git checkout auto-fix-batch && git reset --hard main; }
fi

# Run claude with timeout
timeout $MAX_RUNTIME claude -p "Fix GitHub issue #$NUMBER: $TITLE. Read the issue with: gh issue view $NUMBER. Make the fix, run tsc --noEmit to verify. Commit with message 'fix #$NUMBER: $TITLE'. Keep changes minimal and focused." --dangerously-skip-permissions >> $LOG 2>&1

EXIT_CODE=$?
if [ $EXIT_CODE -eq 124 ]; then
  echo "$(date): Claude timed out after ${MAX_RUNTIME}s on #$NUMBER" >> $LOG
  pkill -f "claude -p" 2>/dev/null
  sleep 3
fi

# Push the branch
git push origin auto-fix-batch --force-with-lease >> $LOG 2>&1

if [ -z "$EXISTING_PR" ]; then
  gh pr create --repo nicolasmertens/mrtns-projects --base main --head auto-fix-batch --title "Auto-fix batch" --body "Automated fixes batch. Merge when ready." >> $LOG 2>&1
  echo "$(date): Created new batch PR for #$NUMBER" >> $LOG
else
  CURRENT_BODY=$(gh pr view "$EXISTING_PR" --repo nicolasmertens/mrtns-projects --json body --jq '.body')
  NEW_BODY="$CURRENT_BODY
- Fixed #$NUMBER: $TITLE"
  gh pr edit "$EXISTING_PR" --repo nicolasmertens/mrtns-projects --body "$NEW_BODY" >> $LOG 2>&1
  echo "$(date): Added #$NUMBER to batch PR #$EXISTING_PR" >> $LOG
fi

echo "$(date): Finished #$NUMBER" >> $LOG
