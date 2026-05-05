#!/bin/bash
cd "/Users/vadymsyliava/Pilot AGI"
export PILOT_DAEMON_SPAWNED=1
export PILOT_TASK_ID="Pilot AGI-vav"
export PILOT_AGENT_TYPE=general
PROMPT=$(cat "/Users/vadymsyliava/Pilot AGI/.claude/pilot/state/spawn-context/Pilot AGI-vav.prompt")
exec claude --agent -p "$PROMPT"
