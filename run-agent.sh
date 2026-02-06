#!/bin/bash
# Universal agent launcher
# Usage: run-agent.sh <agent-name>
# Reads ~/agents/<agent-name>.md for the goal prompt, runs Claude Code with it.

export PATH=/Users/macmini/.local/bin:/opt/homebrew/bin:/usr/local/bin:$PATH

AGENT_NAME="$1"
AGENT_DIR="$HOME/agents"
AGENT_FILE="$AGENT_DIR/$AGENT_NAME.md"
LOG_DIR="$HOME/agent-logs"
LOG="$LOG_DIR/$AGENT_NAME.log"
LOCK_DIR="$HOME/agent-locks"
LOCK="$LOCK_DIR/$AGENT_NAME.lock"
MAX_RUNTIME=${2:-1800}  # Default 30 min, overridable as 2nd arg

mkdir -p "$LOG_DIR" "$LOCK_DIR"

ts() { date "+%Y-%m-%d %H:%M:%S"; }

# Validate
if [ -z "$AGENT_NAME" ]; then
  echo "Usage: run-agent.sh <agent-name> [max_seconds]"
  exit 1
fi

if [ ! -f "$AGENT_FILE" ]; then
  echo "$(ts) [ERROR] Agent file not found: $AGENT_FILE" >> "$LOG"
  exit 1
fi

# Lock check - prevent duplicate runs of the same agent
if [ -f "$LOCK" ]; then
  LOCK_PID=$(cat "$LOCK")
  if kill -0 "$LOCK_PID" 2>/dev/null; then
    ELAPSED=$(ps -o etimes= -p "$LOCK_PID" 2>/dev/null | tr -d ' ')
    if [ -n "$ELAPSED" ] && [ "$ELAPSED" -gt "$MAX_RUNTIME" ]; then
      echo "$(ts) [TIMEOUT] Agent '$AGENT_NAME' PID $LOCK_PID stuck for ${ELAPSED}s, killing" >> "$LOG"
      kill "$LOCK_PID" 2>/dev/null
      sleep 3
      kill -9 "$LOCK_PID" 2>/dev/null
      rm -f "$LOCK"
    else
      echo "$(ts) [SKIP] Agent '$AGENT_NAME' already running (PID $LOCK_PID, ${ELAPSED}s)" >> "$LOG"
      exit 0
    fi
  else
    # Stale lock
    rm -f "$LOCK"
  fi
fi

# Read the agent prompt
PROMPT=$(cat "$AGENT_FILE")

# Extract metadata from frontmatter if present
WORK_DIR=$(echo "$PROMPT" | grep -m1 "^workdir:" | sed 's/^workdir:\s*//')
WORK_DIR="${WORK_DIR:-$HOME}"

# Strip frontmatter (everything between --- markers) for the actual prompt
CLEAN_PROMPT=$(echo "$PROMPT" | sed '/^---$/,/^---$/d')

echo "$(ts) [START] Agent '$AGENT_NAME' (timeout: ${MAX_RUNTIME}s)" >> "$LOG"

# Write lock
echo $$ > "$LOCK"

# Run Claude Code with the agent's goal
cd "$WORK_DIR"
timeout "$MAX_RUNTIME" claude -p "$CLEAN_PROMPT" --dangerously-skip-permissions >> "$LOG" 2>&1
EXIT_CODE=$?

# Clean up
rm -f "$LOCK"

if [ $EXIT_CODE -eq 124 ]; then
  echo "$(ts) [TIMEOUT] Agent '$AGENT_NAME' killed after ${MAX_RUNTIME}s" >> "$LOG"
  pkill -f "claude -p" 2>/dev/null
elif [ $EXIT_CODE -ne 0 ]; then
  echo "$(ts) [ERROR] Agent '$AGENT_NAME' exited with code $EXIT_CODE" >> "$LOG"
else
  echo "$(ts) [DONE] Agent '$AGENT_NAME' completed successfully" >> "$LOG"
fi
