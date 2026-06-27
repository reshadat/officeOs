![License](https://img.shields.io/badge/license-MIT-green) ![Node](https://img.shields.io/badge/node-20%2B-brightgreen) ![Platform](https://img.shields.io/badge/platform-macOS%20%7C%20Linux-lightgrey)

# officeOs

**Persistent 24/7 Claude Code agents you control from Slack.**

---

```
Slack DM

You:     Morning. What did you ship overnight?
Boss:    Overnight recap: 4 tasks done, 2 experiments ran,
         3 scripts drafted. One item needs your approval.

You:     allow
Boss:    Approved. Running now.

You:     Add a cron to check my inbox every morning at 8am.
Boss:    Done. "morning-inbox" cron set — runs daily at 08:00.
```

---

## How it works

officeOs runs Claude Code agents 24/7 in PTY sessions via PM2. You talk to them from Slack — DMs or a channel. Type `allow` or `deny` to approve tool calls. Agents coordinate via a shared file bus, run crons automatically, and restart themselves after crashes.

```
Slack DM / Channel
      ↓
officeOs daemon (Node.js, PM2)
  └─ SlackControlPlane per agent (Socket Mode, xapp- token)
       ├─ "allow"/"deny" → writes hook-response-{id}.json (unblocks hook)
       └─ any other message → FastChecker → injectMessage() → Claude PTY
      ↓
Claude replies via: officeos bus send-slack <channel> "<reply>"
      ↓
Slack
```

---

## Quick Start

**Requirements:** Node.js 20+, Claude Code, PM2, Slack app.

```bash
# 1. Clone and install
git clone https://github.com/reshadat/officeOs.git
cd officeOs
npm install && npm run build
npm install -g .

# 2. Create org and agents
officeos install
officeos init myorg
officeos add-agent orchestrator --template orchestrator --org myorg
officeos add-agent analyst --template analyst --org myorg

# 3. Add Slack credentials to the orchestrator
cat > orgs/myorg/agents/orchestrator/.env << 'EOF'
SLACK_BOT_TOKEN=xoxb-...
SLACK_APP_TOKEN=xapp-...
SLACK_USER_ID=U...                     # Required. Only this user can approve/deny.
SLACK_CHANNEL_ID=C...                  # Single channel to listen to
# SLACK_ALLOWED_CHANNELS=C...,C...     # Or: multiple channels (overrides SLACK_CHANNEL_ID)
# SLACK_READONLY_USERS=U...,U...       # Can chat with agent, cannot approve/deny
# SLACK_ALLOWED_DOMAINS=company.com    # Reject users whose Slack email doesn't match
EOF

# 4. Disable theta-wave (saves tokens)
mkdir -p orgs/myorg/agents/orchestrator/experiments
echo '{"theta_wave":{"enabled":false}}' > orgs/myorg/agents/orchestrator/experiments/config.json

# 5. Wire Slack hooks in orchestrator settings.json
# See "Hook Configuration" below.

# 6. Start
officeos ecosystem
pm2 start ecosystem.config.js && pm2 save && pm2 startup
```

---

## Slack App Setup

1. [api.slack.com/apps](https://api.slack.com/apps) → Create App → **Enable Socket Mode** → generate App-Level Token (`xapp-...`) with scope `connections:write`
2. **Bot Token Scopes:** `channels:history`, `chat:write`, `chat:write.public`, `groups:history`, `im:history`, `im:read`, `im:write`, `channels:read`, `mpim:write`, `reactions:write`
3. **Event Subscriptions → Bot events:** `message.channels`, `message.groups`, `message.im`, `member_joined_channel`
4. Install to workspace → copy Bot Token (`xoxb-...`)
5. Your **User ID**: Profile → More → Copy Member ID (`U...`)
6. **Channel ID**: Right-click channel → Copy link → extract `C...` segment

### Threaded Replies

officeOs replies in the same Slack thread as the message it's responding to. When you reply in a thread, the agent receives the full thread context (up to 20 messages) before your latest message. No configuration needed — thread tracking is automatic.

### Emoji Reactions

Agents acknowledge messages with emoji reactions instead of words:

- 👀 `:eyes` — "I saw this and I'm working on it"
- ✅ `:white_check_mark` — done
- ❌ `:x` — error

Agents react via: `officeos bus react <channel-id> <message-ts> <emoji-name>`

The `reactions:write` scope (step 2 above) enables this. If you omit it, reactions fail silently — agents fall back to text replies.

---

## Hook Configuration

Add to your orchestrator's `settings.json`:

```json
{
  "hooks": {
    "PreToolUse": [
      {
        "matcher": "AskUserQuestion",
        "hooks": [{ "type": "command", "command": "node dist/hooks/hook-ask-slack.js" }]
      },
      {
        "matcher": "ExitPlanMode",
        "hooks": [{ "type": "command", "command": "node dist/hooks/hook-planmode-slack.js" }]
      },
      {
        "matcher": "*",
        "hooks": [{ "type": "command", "command": "node dist/hooks/hook-permission-slack.js" }]
      }
    ],
    "PreCompact": [{ "type": "command", "command": "node dist/hooks/hook-compact-slack.js" }],
    "SessionEnd": [
      { "type": "command", "command": "node dist/hooks/hook-crash-alert.js" },
      { "type": "command", "command": "node dist/hooks/hook-crash-alert-slack.js" }
    ]
  }
}
```

When a tool call needs approval, the hook sends a Slack message and waits. Reply `allow` or `deny`. 30-minute timeout: permission hooks deny, plan hooks auto-approve.

---

## Agent Config

**Orchestrator** (`config.json`):
```json
{
  "enabled": true,
  "slack_polling": true,
  "runtime": "claude-code",
  "model": "claude-sonnet-4-6"
}
```

**Worker agent** (`config.json`):
```json
{
  "enabled": true,
  "slack_polling": false,
  "runtime": "claude-code",
  "model": "claude-haiku-4-5-20251001"
}
```

**Theta-wave off** (`experiments/config.json` in any agent dir):
```json
{ "theta_wave": { "enabled": false } }
```

| Field | Notes |
|---|---|
| `slack_polling` | `false` on worker agents — only the orchestrator needs a Slack socket |
| `model` | `claude-haiku-4-5-20251001` for workers — ~10x cheaper than Sonnet |

---

## Cost Controls

**Model tiering** — set `model` per agent. Haiku for workers, Sonnet for orchestrator.

**Theta-wave off** — `{"theta_wave":{"enabled":false}}` in `experiments/config.json`. Do this for every agent.

**Headroom** — optional context compression, 60-90% token reduction on tool outputs:
```bash
headroom proxy --port 8787 &
# Add to agent .env:
ANTHROPIC_BASE_URL=http://localhost:8787
```

---

## CLI Reference

```bash
officeos install             # Set up state directories
officeos init <org>          # Create an organization
officeos add-agent <name>    # Add an agent (--template, --org, --runtime)
officeos enable <name>       # Enable agent in daemon
officeos ecosystem           # Generate PM2 config
officeos status              # Agent health table
officeos doctor              # Check prerequisites
officeos list-agents         # List agents
officeos dashboard           # Start web dashboard (--port 3000)
officeos bus send-slack <channel-id> '<message>'
```

| Command | Description |
|---|---|
| `officeos sync-jds` | Sync all agent JD blocks → jds-registry.md + collaborator files |
| `officeos list-jds` | List all agents and their job descriptions |

`cortextos` is a legacy alias — existing scripts continue to work.

---

## Requirements

| Dependency | Notes |
|---|---|
| Node.js 20+ | [nodejs.org](https://nodejs.org) |
| macOS or Linux | |
| Claude Code | `npm install -g @anthropic-ai/claude-code` + `claude login` |
| PM2 | `npm install -g pm2` |
| Slack app | See setup above |

---

## Templates

| Template | Description |
|---|---|
| `orchestrator` | Coordinates agents, manages goals, handles approvals |
| `analyst` | System health, metrics, autoresearch |
| `agent` | General-purpose worker |
| `agent-codex` | Codex-runtime worker (`runtime: codex-app-server`) |

---

## Routing Protocol

The orchestrator routes queries to specialist agents via bus message prefixes:

| Message | Direction | Meaning |
|---------|-----------|---------|
| `ROUTED_QUERY: <msg>` | Orch → Agent | Handle this query |
| `ROUTE_REPLY: <answer>` | Agent → Orch | Answer to relay to human |
| `ROUTE_ESCALATE: <reason> | ORIGINAL: <msg>` | Agent → Orch | Cannot handle, re-route |
| `ASK_HUMAN: <question>` | Agent → Orch | Need human input |

Bus messages carry a structured envelope (daemon-level): request_id for correlation,
origin_channel for reply routing, hop_count for loop detection (drops at 10).
Agents see only the plain message text — envelope metadata is invisible to them.

---

## Agent Job Descriptions

Each agent declares what it does in `config.json` under the `jd` field:

```json
{
  "jd": {
    "title": "Documentation Specialist",
    "description": "Finds and explains internal documentation",
    "responsibilities": ["Answer questions about internal docs", "Summarize runbooks"],
    "provides": ["Documentation search", "URL summarization"],
    "needs": ["Codebase context"],
    "keywords": ["docs", "wiki", "runbook", "how-to"],
    "out_of_scope": ["Code changes", "Deployments"]
  }
}
```

After filling in JD blocks, run:
```bash
officeos sync-jds
```
This writes a `jds-registry.md` to the orchestrator's dir and `memory/collaborators.md` to matched agents.

The orchestrator reads the registry and routes queries based on semantic intent matching — not keyword lookup. "How does the Snyk parser work?" routes to `codebase-agent` because its responsibility is "Describe internal code behavior", even though "Snyk" isn't in the keywords.

---

## Security

**Designed for corporate Slack.** Multiple trust levels, domain gating, prompt injection mitigations.

### Access model

| Env var | Who | What they can do |
|---|---|---|
| `SLACK_USER_ID` | You (owner) | Chat with agent, approve/deny tool calls. Required — daemon won't start without it. |
| `SLACK_READONLY_USERS` | Colleagues, stakeholders | Chat with agent only. `allow`/`deny` replies silently ignored. |
| *(anyone else)* | — | Completely ignored, even if they can see the channel. |

### Channel control

- `SLACK_CHANNEL_ID` or `SLACK_ALLOWED_CHANNELS` — explicit allowlist of channels. Bot ignores all other channels it's added to.
- Owner DMs always accepted regardless of channel config.
- Readonly users' DMs also accepted if their ID is in `SLACK_READONLY_USERS`.

### Domain gating

Set `SLACK_ALLOWED_DOMAINS=company.com` and the daemon calls `users.info` for every new sender, checks their Slack email domain, and rejects if it doesn't match. Result cached per session. Blocks guest accounts from other workspaces.

### Channel invite control

Bot handles `member_joined_channel` events. If someone other than the owner adds the bot to a channel, the bot immediately leaves and DMs the owner who tried. If the owner adds it, the channel is accepted into the runtime allowlist.

Requires `member_joined_channel` in your Slack app's bot event subscriptions.

### Message labeling

READONLY messages tagged `[READONLY]` in injection header — no embedded prompt instructions. Add behavioral restrictions to the agent's `CLAUDE.md` if needed.

### Residual risks

READONLY users can still send crafted text that misleads the agent. Only add people to `SLACK_READONLY_USERS` that you'd trust with read access.

### Approval gate

Every tool call blocked by a hook sends a Slack message and waits. Only the owner (`SLACK_USER_ID`) can unblock it. 30-minute timeout: permission hooks deny automatically, plan hooks auto-approve.

---

## Docker (recommended for production)

Docker limits blast radius: even if a hook fails and Claude runs unchecked, it can only touch what you explicitly mounted. Host filesystem untouched.

Includes both agent runtimes — Claude Code and Codex.

```bash
# 1. Copy and fill env
cp .env.docker.example .env
# Set OPENAI_API_KEY, WORKSPACE_PATH (and optionally ANTHROPIC_API_KEY)

# 2. Build and start
docker-compose up -d

# 3. Authenticate Claude Code (one-time, interactive OAuth)
docker exec -it officeos claude login
# Opens URL → authenticate in host browser → token stored in named volume

# 4. Mount your orgs/ config outside (already in docker-compose.yml)
# Agent .env files with SLACK_BOT_TOKEN etc. live in orgs/
```

### What's mounted

| Mount | Type | Purpose |
|---|---|---|
| `claude-auth` volume → `/root/.claude` | Named volume | Claude Code OAuth session |
| `codex-auth` volume → `/root/.codex` | Named volume | Codex session |
| `officeos-state` volume → `/root/.officeos` | Named volume | Daemon state, Slack pending files |
| `./orgs` → `/officeos/orgs` | Bind (read-only) | Agent configs, .env files |
| `$WORKSPACE_PATH` → `/workspace` | Bind | The repo your agents work on |

`~/.ssh`, `~/.aws`, host home — **not mounted**. Agents cannot reach them.

### Security flags

- `read_only: true` + `tmpfs /tmp` — root filesystem immutable
- `cap_drop: ALL` + minimum caps back — no Linux privilege escalation
- `no-new-privileges: true` — processes can't gain capabilities
- `pids_limit: 200` — no fork bombs
- `mem_limit: 4g`, `cpus: 2.0` — resource caps

---

## License

MIT — see [LICENSE](./LICENSE).

---

Adapted from [cortextOS](https://github.com/grandamenium/cortextos) by grandamenium.
