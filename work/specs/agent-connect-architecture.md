# Agent-Connect Architecture: Inverted Communication Model

**Task**: Pilot AGI-3y0
**Status**: Design Spec

## Problem Statement

The current PM → Agent communication is file-based polling with 5-30s latency:

```
CURRENT (PM-Push, File-Polling):

PM Daemon                         Agent Terminal
┌──────────┐                     ┌──────────┐
│ Writes to│ ──── bus.jsonl ───→ │ Polls    │
│ bus.jsonl │   (5-30s delay)    │ every 5s │
│          │                     │          │
│ Polls    │ ←── bus.jsonl ───── │ Writes to│
│ every 30s│   (30s delay)       │ bus.jsonl │
└──────────┘                     └──────────┘
```

**Key problems:**
1. PM can't reach agents in real-time (only via file + nudge polling)
2. Agents can't reach PM in real-time (PM reads bus every 30s)
3. Manual terminals have no persistent connection to PM
4. When user opens terminals, PM doesn't know about them until next scan
5. No way for agents to "dial in" to PM for long-running sessions

## Proposed Architecture: Agent-Connect Model

Invert the communication: **agents connect TO PM**, establishing persistent bidirectional channels.

```
NEW (Agent-Connect):

PM Daemon (localhost:3847)
┌────────────────────────────────┐
│  HTTP/WS Server                │
│  ┌──────────────────────────┐  │
│  │ /api/connect    (WS)    │←─── Agent 1 connects on session-start
│  │ /api/heartbeat  (POST)  │←─── Agent 2 connects on session-start
│  │ /api/status     (GET)   │←─── Agent 3 connects on session-start
│  │ /api/report     (POST)  │←─── Manual terminal connects too
│  └──────────────────────────┘  │
│                                │
│  Connected Agents Registry     │
│  ┌──────────────────────────┐  │
│  │ agent-43f5: ws connected │  │
│  │ agent-a1b2: ws connected │  │
│  │ agent-c3d4: ws connected │  │
│  └──────────────────────────┘  │
│                                │
│  File Bus (fallback/persist)   │
│  └── bus.jsonl (unchanged)     │
└────────────────────────────────┘
```

## Design Principles

1. **PM is the hub** — PM daemon runs a lightweight local server. Always on, always reachable.
2. **Agents connect in** — On session-start, every agent (spawned or manual) connects to PM.
3. **Bidirectional channels** — WebSocket for real-time, HTTP for request/response.
4. **File bus is fallback** — If PM server is down, agents fall back to file-based bus. Zero regression.
5. **Manual terminals are first-class** — Same connection path as spawned agents.
6. **Zero new dependencies** — Use Node.js built-in `http` and `ws` (or raw WebSocket protocol).

## Components

### 1. PM Hub Server (`pm-hub.js`)

Lightweight HTTP + WebSocket server embedded in PM daemon.

```javascript
// Starts with PM daemon
class PmHub {
  constructor(port = 3847) {
    this.port = port;
    this.connections = new Map(); // sessionId → ws
    this.server = null;
  }

  start() {
    // HTTP server for REST endpoints
    this.server = http.createServer(this.handleHttp.bind(this));

    // WebSocket upgrade for persistent connections
    this.server.on('upgrade', this.handleWsUpgrade.bind(this));

    this.server.listen(this.port, '127.0.0.1'); // localhost only
  }
}
```

**REST Endpoints:**

| Method | Path | Purpose |
|--------|------|---------|
| `GET` | `/api/status` | PM status, connected agents, queue depth |
| `POST` | `/api/register` | Agent registration (alternative to WS) |
| `POST` | `/api/heartbeat` | Agent heartbeat (alternative to WS) |
| `POST` | `/api/report` | Agent reports task completion/error/checkpoint |
| `GET` | `/api/tasks/ready` | Get ready tasks (agents pull work) |
| `POST` | `/api/tasks/:id/claim` | Claim a task |
| `POST` | `/api/tasks/:id/complete` | Report task completion |
| `GET` | `/api/messages/:sessionId` | Pull pending messages |

**WebSocket Protocol:**

```
Agent → PM:
  { type: "register", sessionId, role, capabilities }
  { type: "heartbeat", sessionId, pressure, claimedTask }
  { type: "task_complete", sessionId, taskId, result }
  { type: "request", sessionId, topic, payload }
  { type: "checkpoint", sessionId, taskId, step, state }

PM → Agent:
  { type: "welcome", pmSessionId, connectedAgents }
  { type: "task_assign", taskId, context }
  { type: "message", from, topic, payload }
  { type: "plan_approval", taskId, approved, feedback }
  { type: "command", action, params }  // e.g. { action: "checkpoint" }
  { type: "shutdown", reason }
```

### 2. Agent Connector (`agent-connector.js`)

Client-side module that agents use to connect to PM. Used by session-start hook.

```javascript
class AgentConnector {
  constructor(sessionId, opts = {}) {
    this.sessionId = sessionId;
    this.pmUrl = opts.pmUrl || 'ws://127.0.0.1:3847';
    this.ws = null;
    this.connected = false;
    this.fallbackToFile = true; // always true
  }

  async connect() {
    try {
      this.ws = new WebSocket(this.pmUrl + '/api/connect');
      // ... handshake, register
      this.connected = true;
    } catch (e) {
      // PM not running — fall back to file bus
      this.connected = false;
      return { connected: false, fallback: 'file_bus' };
    }
  }

  // Send message to PM (WS if connected, file bus if not)
  send(message) {
    if (this.connected && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(message));
    } else {
      // Fallback: write to bus.jsonl
      messaging.sendMessage(this.sessionId, message);
    }
  }

  // Receive messages from PM (WS push, no polling needed)
  onMessage(handler) {
    if (this.ws) {
      this.ws.on('message', (data) => handler(JSON.parse(data)));
    }
  }
}
```

### 3. Connection Flow

#### Spawned Agent (PM starts it):
```
1. PM spawns: `claude -p "work on task X"`
2. session-start.js hook fires
3. Hook creates AgentConnector, calls connect()
4. WS connection established → PM immediately knows about agent
5. PM sends task context via WS (instant, no polling)
6. Agent works, sends heartbeats + status via WS
7. Agent completes → sends task_complete via WS
8. PM processes immediately (no 30s wait)
```

#### Manual Terminal (User opens it):
```
1. User opens terminal, types `/pilot-start`
2. session-start.js hook fires
3. Hook creates AgentConnector, calls connect()
4. WS connection established → PM immediately knows about terminal
5. PM sends: { type: "welcome", readyTasks: [...] }
6. User/agent claims a task → PM tracks it in real-time
7. If PM has a task waiting → PM pushes it: { type: "task_assign", ... }
8. Persistent connection maintained for duration of session
```

#### PM Not Running (Fallback):
```
1. Any terminal starts
2. session-start.js tries connect() → fails (ECONNREFUSED)
3. Falls back to file-based bus (current behavior)
4. Agent works normally with file polling
5. When PM starts later, next heartbeat re-establishes connection
```

### 4. Integration with PM Daemon

Modify `pm-daemon.js` to start the hub server:

```javascript
class PmDaemon {
  constructor(projectRoot, opts) {
    // ... existing code ...
    this.hub = new PmHub(opts.hubPort || 3847);
  }

  async start() {
    // Start hub server first
    await this.hub.start();
    this.log.info('PM Hub listening', { port: this.hub.port });

    // ... existing startup (watcher, loop, etc.) ...

    // Register hub event handlers
    this.hub.on('agent_connected', (sessionId, ws) => {
      this.log.info('Agent connected', { sessionId });
      this._onAgentConnected(sessionId, ws);
    });

    this.hub.on('task_complete', (sessionId, taskId, result) => {
      // Instant processing — no waiting for next tick
      this._onTaskCompleted(taskId, result);
    });

    this.hub.on('agent_disconnected', (sessionId) => {
      this.log.info('Agent disconnected', { sessionId });
      this._onAgentDisconnected(sessionId);
    });
  }
}
```

### 5. Port Discovery

Agents need to know where PM is listening. Three mechanisms:

1. **PID file (primary)**: PM writes port to `.claude/pilot/state/orchestrator/pm-hub.json`:
   ```json
   { "port": 3847, "pid": 12345, "started_at": "..." }
   ```

2. **Environment variable**: `PILOT_PM_PORT=3847` passed to spawned agents.

3. **Default port**: `3847` (if no file or env, try default).

### 6. Session-Start Hook Changes

```javascript
// In session-start.js, after session registration:

const AgentConnector = require('./lib/agent-connector');

// Try to connect to PM hub
const connector = new AgentConnector(sessionId, {
  role: detectedRole,
  capabilities: agentCapabilities
});

const connection = await connector.connect();

if (connection.connected) {
  // Store connector reference for this session
  // WS connection established — PM knows about us
  output.pm_connected = true;
  output.pm_port = connection.port;
} else {
  // PM not running — file bus fallback
  output.pm_connected = false;
  output.fallback = 'file_bus';
}
```

## PM Brain: On-Demand Intelligence with Full Knowledge

The PM daemon is pure Node.js — immortal, no context limits. But it needs Claude's intelligence for judgment calls. The solution: **spawn short-lived `claude -p` sessions pre-loaded with the full PM knowledge base.**

### The Key Insight

The PM daemon is the **persistent memory**. Claude is the **thinking engine**. Each PM brain call gets the full knowledge base injected — it's not "fresh", it's **fully contextualized**.

```
┌─────────────────────────────────────────────────────────────┐
│                  PM DAEMON (Node.js)                         │
│                                                              │
│  ┌─────────────────────────────────────────────────────┐    │
│  │              PM KNOWLEDGE BASE (persistent)          │    │
│  │                                                      │    │
│  │  Product Brief ─── work/PROJECT_BRIEF.md             │    │
│  │  Roadmap State ─── work/ROADMAP.md (current phase)   │    │
│  │  Sprint Plan ───── work/sprints/active-sprint.md     │    │
│  │  Implementation ── work/plans/*.md (approved plans)   │    │
│  │                                                      │    │
│  │  Decision History ── memory/channels/pm-decisions.json│    │
│  │  Research ────────── memory/channels/research.json    │    │
│  │  Decompositions ──── memory/channels/decomp.json     │    │
│  │  Working Context ─── memory/channels/working.json    │    │
│  │                                                      │    │
│  │  Agent States ────── state/sessions/*.json           │    │
│  │  Task Graph ──────── bd ready/in_progress/blocked    │    │
│  │  Escalation Log ──── state/escalations/log.jsonl     │    │
│  │  Cost Data ───────── state/costs/                    │    │
│  │  Artifact Registry ─ state/artifacts/                │    │
│  │                                                      │    │
│  │  Conversation Thread (per-agent Q&A history)         │    │
│  └─────────────────────────────────────────────────────┘    │
│                          │                                   │
│            When agent asks a question...                     │
│                          ▼                                   │
│  ┌─────────────────────────────────────────────────────┐    │
│  │           PM BRAIN BUILDER (pm-brain.js)             │    │
│  │                                                      │    │
│  │  1. Gather relevant knowledge from PM KB             │    │
│  │  2. Build context capsule (prioritized, capped)      │    │
│  │  3. Include conversation history with this agent     │    │
│  │  4. Construct PM persona prompt                      │    │
│  │  5. Spawn: claude -p "<PM Knowledge + Question>"     │    │
│  │  6. Parse response                                   │    │
│  │  7. Store decision in PM decision history            │    │
│  │  8. Return answer to requesting agent                │    │
│  └─────────────────────────────────────────────────────┘    │
│                                                              │
└─────────────────────────────────────────────────────────────┘
```

### PM Knowledge Base Sources

The PM daemon maintains a structured knowledge base from these sources (all already exist in the project):

| Source | Path | What It Contains |
|--------|------|------------------|
| Product Brief | `work/PROJECT_BRIEF.md` | Vision, goals, constraints, target users |
| Roadmap | `work/ROADMAP.md` | Milestones, phases, current progress |
| Sprint Plan | `work/sprints/*.md` | Active sprint tasks and priorities |
| Implementation Plans | `work/plans/*.md` | Approved plans for active tasks |
| PM Decisions | `memory/channels/pm-decisions.json` | Every past decision with context and outcome |
| Research Findings | `memory/channels/research-findings.json` | Best practices, patterns, tech decisions |
| Task Decompositions | `memory/channels/task-decompositions.json` | Subtask DAGs with dependency analysis |
| Working Context | `memory/channels/working-context.json` | Current PM and agent states |
| Agent Sessions | `state/sessions/*.json` | Who's working on what, health, pressure |
| Task Graph | `.beads/issues.jsonl` | All tasks with status, deps, priority |
| Escalation History | `state/escalations/log.jsonl` | Past escalations, resolutions, patterns |
| Cost Data | `state/costs/` | Budget usage per task/agent/day |
| Artifact Registry | `state/artifacts/` | Cross-task output contracts and deps |
| PM Action Log | `state/orchestrator/action-log.jsonl` | Every PM action with timestamp |
| Conversation Threads | In-memory (Node.js Map) | Per-agent Q&A history for multi-turn |

### PM Brain Builder (`pm-brain.js`)

The core module that constructs contextualized PM brain calls:

```javascript
class PmBrain {
  constructor(projectRoot, opts = {}) {
    this.projectRoot = projectRoot;
    this.knowledgeBase = new PmKnowledgeBase(projectRoot);
    this.conversations = new Map(); // agentSessionId → [{role, content}]
    this.maxPromptSize = opts.maxPromptSize || 16000; // 16KB cap
  }

  /**
   * Ask the PM brain a question on behalf of an agent.
   * Spawns claude -p with full PM knowledge injected.
   */
  async ask(agentSessionId, question, context = {}) {
    // 1. Build the knowledge capsule (prioritized by relevance)
    const knowledge = this.knowledgeBase.gather({
      agentId: agentSessionId,
      taskId: context.taskId,
      topic: context.topic,         // helps prioritize which knowledge to include
      includeDecisionHistory: true,
      includeAgentStates: true,
      includeTaskGraph: true,
      includeResearch: true
    });

    // 2. Get conversation history with this agent
    const thread = this.conversations.get(agentSessionId) || [];

    // 3. Build the PM persona prompt
    const prompt = this._buildPrompt(knowledge, thread, question, context);

    // 4. Spawn claude -p with full context
    const response = callClaude(prompt, {
      projectRoot: this.projectRoot,
      timeoutMs: 120000  // 2 min for complex decisions
    });

    // 5. Store the Q&A in conversation history
    thread.push({ role: 'agent', content: question, ts: Date.now() });
    thread.push({ role: 'pm', content: response.result, ts: Date.now() });
    this.conversations.set(agentSessionId, thread.slice(-10)); // keep last 10 turns

    // 6. Extract and store any decisions made
    if (response.result?.decision) {
      this.knowledgeBase.recordDecision(response.result.decision);
    }

    return response;
  }

  _buildPrompt(knowledge, thread, question, context) {
    // Prioritized sections, fitted within maxPromptSize
    const sections = [];

    // Always include: PM identity and product brief
    sections.push({
      priority: 1,
      content: `# You are the PM Agent for "${knowledge.projectName}"

${knowledge.productBrief}

## Your Role
You are the Project Manager for this software project. You make decisions about:
- Task prioritization and assignment
- Code review approvals
- Architecture guidance
- Conflict resolution
- Agent coordination
- Risk assessment

You have full knowledge of the project state, all agent activities, and decision history.
Respond with actionable, specific guidance. Always include a JSON "decision" field if making a decision.`
    });

    // Current project state
    sections.push({
      priority: 2,
      content: `## Current Project State
- Milestone: ${knowledge.currentMilestone}
- Phase: ${knowledge.currentPhase}
- Active Agents: ${knowledge.activeAgents.length}
- Tasks In Progress: ${knowledge.tasksInProgress.map(t => `${t.id}: ${t.title}`).join(', ')}
- Tasks Blocked: ${knowledge.tasksBlocked.length}
- Budget Used: ${knowledge.budgetUsedToday}`
    });

    // Decision history (recent, relevant)
    sections.push({
      priority: 3,
      content: `## Recent PM Decisions
${knowledge.recentDecisions.map(d =>
  `- [${d.ts}] ${d.type}: ${d.summary} (outcome: ${d.outcome || 'pending'})`
).join('\n')}`
    });

    // Agent states
    sections.push({
      priority: 4,
      content: `## Active Agent States
${knowledge.activeAgents.map(a =>
  `- ${a.agent_name} (${a.role || 'general'}): task=${a.claimed_task || 'idle'}, pressure=${a.pressure || 'unknown'}`
).join('\n')}`
    });

    // Task graph (relevant subset)
    sections.push({
      priority: 5,
      content: `## Task Graph
${knowledge.taskSummary}`
    });

    // Research findings (relevant to question topic)
    if (knowledge.relevantResearch) {
      sections.push({
        priority: 6,
        content: `## Relevant Research
${knowledge.relevantResearch}`
      });
    }

    // Implementation plan for the agent's current task
    if (knowledge.agentPlan) {
      sections.push({
        priority: 7,
        content: `## Agent's Current Plan
${knowledge.agentPlan}`
      });
    }

    // Conversation history with this agent
    if (thread.length > 0) {
      sections.push({
        priority: 8,
        content: `## Previous Conversation with This Agent
${thread.map(t => `${t.role.toUpperCase()}: ${typeof t.content === 'string' ? t.content : JSON.stringify(t.content)}`).join('\n\n')}`
      });
    }

    // The actual question
    sections.push({
      priority: 0, // highest - always included
      content: `## Agent's Question
Agent ${context.agentName || agentSessionId} (working on ${context.taskId || 'unknown'}):

${question}

## Your Response
Respond as the PM. Be specific, actionable, and authoritative. Format:
{
  "guidance": "your detailed response",
  "decision": { "type": "...", "action": "...", "reason": "..." },
  "follow_up": "any question back to the agent (optional)"
}`
    });

    // Fit within prompt size limit (prioritize by priority number)
    return this._fitToLimit(sections);
  }

  _fitToLimit(sections) {
    // Sort by priority (0 = must include, higher = can trim)
    sections.sort((a, b) => a.priority - b.priority);
    let result = '';
    for (const section of sections) {
      if ((result + section.content).length > this.maxPromptSize) {
        // Truncate this section to fit
        const remaining = this.maxPromptSize - result.length - 100;
        if (remaining > 200) {
          result += '\n\n' + section.content.substring(0, remaining) + '\n[...truncated]';
        }
        break;
      }
      result += '\n\n' + section.content;
    }
    return result;
  }
}
```

### PM Knowledge Base (`pm-knowledge-base.js`)

Persistent knowledge gatherer that reads from all PM sources:

```javascript
class PmKnowledgeBase {
  constructor(projectRoot) {
    this.projectRoot = projectRoot;
    this.cache = {};           // Cached reads (TTL-based)
    this.decisionLog = [];     // In-memory decision history
  }

  /**
   * Gather PM knowledge relevant to a question.
   * Reads from disk, caches results, prioritizes by relevance.
   */
  gather(opts = {}) {
    return {
      projectName: this._readProjectName(),
      productBrief: this._readProductBrief(),           // work/PROJECT_BRIEF.md
      currentMilestone: this._readCurrentMilestone(),    // work/ROADMAP.md → active milestone
      currentPhase: this._readCurrentPhase(),            // work/ROADMAP.md → active phase
      activeAgents: this._readActiveAgents(),             // state/sessions/*.json
      tasksInProgress: this._readTasksByStatus('in_progress'),
      tasksBlocked: this._readTasksByStatus('blocked'),
      recentDecisions: this._readRecentDecisions(20),    // memory/channels/pm-decisions.json
      relevantResearch: this._readResearch(opts.topic),  // memory/channels/research-findings.json
      agentPlan: this._readAgentPlan(opts.taskId),       // work/plans/<taskId>.md
      taskSummary: this._readTaskSummary(),              // bd ready + in_progress + blocked
      budgetUsedToday: this._readBudgetUsed(),           // state/costs/
      escalationHistory: this._readEscalations(10)       // state/escalations/log.jsonl
    };
  }

  /** Record a new PM decision (persisted to memory channel + in-memory) */
  recordDecision(decision) {
    decision.ts = new Date().toISOString();
    this.decisionLog.push(decision);

    // Also persist to pm-decisions memory channel
    memory.publish('pm-decisions', {
      decisions: [decision]
    }, { sessionId: 'pm-daemon', summary: `PM decision: ${decision.type}` });
  }
}
```

### Agent → PM Conversation Flow

```
Execution Agent                PM Daemon (Node.js)           PM Brain (claude -p)
      │                              │                              │
      │  "I'm stuck on auth          │                              │
      │   middleware. Should I        │                              │
      │   use passport.js or         │                              │
      │   custom JWT?"               │                              │
      │ ────────── WS ──────────→    │                              │
      │                              │  1. Receive question          │
      │                              │  2. Load PM Knowledge Base:   │
      │                              │     - Product Brief           │
      │                              │     - Roadmap: M5 Phase 5.1   │
      │                              │     - Decision: "chose JWT    │
      │                              │       for microservices in    │
      │                              │       project X"              │
      │                              │     - Research: "passport.js  │
      │                              │       vs JWT comparison"      │
      │                              │     - Agent's plan steps      │
      │                              │     - Previous Q&A thread     │
      │                              │  3. Build prompt (16KB cap)   │
      │                              │  4. Spawn claude -p ────────→ │
      │                              │                               │ Thinks with full
      │                              │                               │ PM knowledge...
      │                              │  5. Get response ←──────────  │ Returns JSON
      │                              │  6. Store decision in KB      │ (process exits)
      │                              │  7. Store Q&A in thread       │
      │  "Use passport.js with      │                              │
      │   JWT strategy. Here's      │                              │
      │   the pattern we use..."    │                              │
      │ ←───────── WS ────────────  │                              │
      │                              │                              │
      │  (continues implementing)    │                              │
      │                              │                              │
      │  "Follow-up: should the     │                              │
      │   refresh token go in       │                              │
      │   httpOnly cookie?"         │                              │
      │ ────────── WS ──────────→   │                              │
      │                              │  Same flow, but now prompt    │
      │                              │  includes previous Q&A:       │
      │                              │  "You previously told agent   │
      │                              │   to use passport.js+JWT..."  │
      │                              │  ────────────────────────────→ │ Continues with
      │                              │                               │ conversation
      │                              │  ←──────────────────────────  │ context
      │  "Yes, httpOnly cookie      │                              │
      │   with SameSite=Strict..."  │                              │
      │ ←───────── WS ────────────  │                              │
```

### Multi-Turn Conversation State

The PM daemon maintains conversation threads in-memory (per agent):

```javascript
// In PmBrain:
this.conversations = new Map();
// Key: agentSessionId
// Value: [
//   { role: 'agent', content: 'Should I use passport.js?', ts: 1707... },
//   { role: 'pm', content: { guidance: 'Use passport with JWT strategy...', decision: {...} }, ts: 1707... },
//   { role: 'agent', content: 'Should refresh token go in cookie?', ts: 1707... },
//   { role: 'pm', content: { guidance: 'Yes, httpOnly with SameSite...' }, ts: 1707... }
// ]
```

Each follow-up `claude -p` call includes the relevant conversation history, so the PM brain has continuity even though each call is a separate process. The conversation state lives in the Node.js daemon (immortal), not in any Claude session.

### Decision Types That Trigger PM Brain

| Trigger | Current (pm-decisions.js) | New (pm-brain.js) |
|---------|--------------------------|---------------------|
| Agent asks for help | Not possible | Full KB + conversation thread |
| Diff review | Diff only, no project context | Diff + plan + task + decisions |
| Task decomposition | Description only | Description + roadmap + research + past decomps |
| Conflict resolution | Conflict markers only | Conflict + both agents' plans + intent |
| Plan approval | Not used | Plan + risk + similar past plans + outcomes |
| Agent stuck | Escalate to human | PM brain advises, escalates only if needed |
| Architecture question | Not possible | Product brief + roadmap + research + decisions |

### Cost Controls

- Each PM brain call is capped at 16KB prompt → bounded cost
- Conversation threads keep only last 10 turns per agent
- Brain calls have 120s timeout
- Policy configurable: `pm_brain.max_calls_per_hour: 30` in `policy.yaml`
- Mechanical decisions (spawn, health, cleanup) still pure Node.js — free
- PM brain only spawned when agent asks or complex decision needed

## Migration Strategy

### Phase 1: PM Hub Server (backward-compatible)
- Add `pm-hub.js` to PM daemon
- PM starts HTTP/WS server alongside existing file-based system
- File bus continues working unchanged
- **Zero breaking changes**

### Phase 2: Agent Connector (opt-in)
- Add `agent-connector.js`
- Session-start hook tries WS connection, falls back to file bus
- Agents that connect get real-time messages
- Agents that don't still work via file polling

### Phase 3: Real-Time Event Processing
- PM processes WS events immediately (not waiting for tick)
- Task assignment via WS push (instant, not waiting for agent poll)
- Heartbeats via WS (1s granularity instead of 30s file check)

### Phase 4: Deprecate Polling-First
- File bus becomes persistence layer only (audit trail)
- Primary communication is WS
- AgentPoller only activates when WS is disconnected

## Security Considerations

- **Localhost only**: Server binds to `127.0.0.1`, not `0.0.0.0`
- **Session token**: Agent must present valid session ID on connect (verified against session files)
- **No external access**: No port forwarding, no TLS needed for local
- **Rate limiting**: Basic rate limiting on REST endpoints

## Dependencies

- `ws` npm package (or raw WebSocket from Node.js 21+ `--experimental-websocket`)
- Or: pure HTTP long-polling as alternative to WebSocket (no new deps)

## Fallback Guarantees

| Scenario | Behavior |
|----------|----------|
| PM not running | Agent uses file bus (current behavior) |
| WS disconnects mid-session | Agent falls back to file bus, reconnects on next heartbeat |
| PM restarts | Agents auto-reconnect (WS reconnect with backoff) |
| Agent crashes | PM detects WS close event → immediate cleanup (no 30s stale wait) |
| Network issue (localhost) | Essentially impossible, but fallback covers it |

## Benefits

| Current (File Polling) | New (Agent-Connect) |
|------------------------|---------------------|
| 5-30s message latency | <100ms message latency |
| PM discovers agents at next tick | PM knows instantly on connect |
| Agents poll for work | PM pushes work to agents |
| Crash detection: 30s stale check | Crash detection: WS close event (instant) |
| Manual terminals are second-class | Manual terminals connect same as spawned |
| No real-time dashboard possible | Real-time dashboard via WS events |
| Bus file grows, needs compaction | WS is ephemeral, bus is just audit log |
