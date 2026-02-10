---
name: pilot-message
description: Send and receive inter-agent messages. Check inbox, send requests, broadcast updates, delegate tasks to other agent sessions.
allowed-tools: Read, Bash, Glob, Grep
---

# Inter-Agent Messaging

You are managing inter-agent communication via the message bus.

## Arguments

Parse the user's command arguments to determine the action:

- `/pilot-message` (no args) → Show inbox
- `/pilot-message send <session-id> <text>` → Send notification
- `/pilot-message request <session-id> <topic> <text>` → Send blocking request
- `/pilot-message broadcast <topic> <text>` → Broadcast to all agents
- `/pilot-message status` → Show bus statistics
- `/pilot-message delegate <session-id> <task-title>` → Delegate task

## Step 1: Detect current session

```bash
SESSION_FILE=$(ls -t .claude/pilot/state/sessions/S-*.json 2>/dev/null | head -1)
if [ -n "$SESSION_FILE" ]; then
  node -e "const s=JSON.parse(require('fs').readFileSync('$SESSION_FILE','utf8'));console.log(JSON.stringify({id:s.session_id,task:s.claimed_task}))"
fi
```

Store `session_id` for use as `from` in messages.

## Step 2: Route by action

### Action: inbox (default)

Read pending messages for this session:

```bash
node -e "
const m = require('./.claude/pilot/hooks/lib/messaging');
const sessionId = '<SESSION_ID>';
const { messages, cursor } = m.readMessages(sessionId);
if (messages.length === 0) {
  console.log('No pending messages.');
} else {
  messages.forEach(msg => {
    const age = Math.round((Date.now() - new Date(msg.ts).getTime()) / 1000);
    const from = msg.from || 'unknown';
    const prio = msg.priority === 'blocking' ? '[BLOCKING]' : msg.priority === 'normal' ? '[NORMAL]' : '[FYI]';
    console.log(prio + ' ' + msg.type + ' from ' + from + ' (' + age + 's ago)');
    console.log('  Topic: ' + (msg.topic || 'none'));
    console.log('  ' + JSON.stringify(msg.payload));
    if (msg.type === 'request' && msg.ack && msg.ack.required) {
      console.log('  -> Needs response (correlation_id: ' + msg.id + ')');
    }
    console.log('');
  });
  // Acknowledge all read messages
  m.acknowledgeMessages(sessionId, cursor, messages.map(x => x.id));
}
"
```

Display results in a formatted box:

```
╔══════════════════════════════════════════════════════════════╗
║  INBOX — {session_id}                                        ║
╚══════════════════════════════════════════════════════════════╝

{priority} {type} from {from} ({age}s ago)
  Topic: {topic}
  {payload summary}
  → Needs response (use /pilot-message respond {id})

────────────────────────────────────────────────────────────────
  {N} message(s) | {blocking} blocking | {normal} normal
────────────────────────────────────────────────────────────────
```

### Action: send

```bash
node -e "
const m = require('./.claude/pilot/hooks/lib/messaging');
const result = m.sendNotification('<FROM>', '<TO>', '<TOPIC>', { text: '<TEXT>' });
console.log(result.success ? 'Sent: ' + result.id : 'Error: ' + result.error);
"
```

### Action: request

```bash
node -e "
const m = require('./.claude/pilot/hooks/lib/messaging');
const result = m.sendRequest('<FROM>', '<TO>', '<TOPIC>', { text: '<TEXT>' }, { priority: 'blocking' });
console.log(result.success ? 'Request sent: ' + result.id + ' (waiting for response)' : 'Error: ' + result.error);
"
```

### Action: broadcast

```bash
node -e "
const m = require('./.claude/pilot/hooks/lib/messaging');
const result = m.sendBroadcast('<FROM>', '<TOPIC>', { text: '<TEXT>' });
console.log(result.success ? 'Broadcast sent: ' + result.id : 'Error: ' + result.error);
"
```

### Action: delegate

```bash
node -e "
const m = require('./.claude/pilot/hooks/lib/messaging');
const result = m.delegateTask('<FROM>', '<TO>', { title: '<TASK_TITLE>', description: '<DESCRIPTION>' });
console.log(result.success ? 'Task delegated: ' + result.id : 'Error: ' + result.error);
"
```

### Action: status

```bash
node -e "
const m = require('./.claude/pilot/hooks/lib/messaging');
const stats = m.getBusStats();
const session = require('./.claude/pilot/hooks/lib/session');
const active = session.getActiveSessions();
console.log(JSON.stringify({ ...stats, active_sessions: active.length }, null, 2));
"
```

Display:

```
╔══════════════════════════════════════════════════════════════╗
║  MESSAGE BUS STATUS                                          ║
╚══════════════════════════════════════════════════════════════╝

  Bus size:        {size_bytes} bytes
  Total messages:  {message_count}
  Active cursors:  {active_cursors}
  Active sessions: {active_sessions}
  Needs compaction: {yes/no}
────────────────────────────────────────────────────────────────
```

### Action: respond

For responding to a request:

```bash
node -e "
const m = require('./.claude/pilot/hooks/lib/messaging');
const result = m.sendResponse('<FROM>', '<CORRELATION_ID>', { text: '<RESPONSE_TEXT>' }, { to: '<ORIGINAL_SENDER>' });
console.log(result.success ? 'Response sent: ' + result.id : 'Error: ' + result.error);
"
```

## Step 3: Show active sessions (for targeting)

When the user needs to know who to message, list active sessions:

```bash
node -e "
const session = require('./.claude/pilot/hooks/lib/session');
const active = session.getActiveSessions();
active.forEach(s => {
  console.log(s.session_id + ' | task: ' + (s.claimed_task || 'none') + ' | areas: ' + (s.locked_areas || []).join(','));
});
"
```

## Important Notes

- Always use the CURRENT session ID as `from`
- Session IDs look like `S-xxxxx-yyyy`
- Messages are persistent (survive session restarts)
- Blocking messages trigger a nudge file for faster delivery
- Messages expire after their TTL (default: 5min normal, 30s blocking)
