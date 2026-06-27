<h1 align="center">officeOs</h1>

<p align="center">
  <em>Your team that never sleeps. Controlled from Slack.</em>
</p>

<p align="center">
  <img src="https://img.shields.io/badge/license-MIT-111111?style=flat-square" alt="MIT">
  <img src="https://img.shields.io/badge/node-20%2B-111111?style=flat-square" alt="Node 20+">
  <img src="https://img.shields.io/badge/platform-macOS%20%7C%20Linux-111111?style=flat-square" alt="macOS / Linux">
  <img src="https://img.shields.io/badge/runtime-Claude%20Code%20%7C%20Codex-111111?style=flat-square" alt="Claude Code / Codex">
  <img src="https://img.shields.io/badge/Slack-Socket%20Mode-111111?style=flat-square" alt="Slack Socket Mode">
</p>

---

You have twenty things running overnight. You know exactly which one will fail. You'll wake up at 3am, check Slack, stay up two hours fixing it, and be useless in the morning standup.

Or you run officeOs.

A persistent team of AI agents on your infra. They watch. They act. When something needs a human call — a deploy approval, a judgment call, a thing only you can say yes to — they message you in Slack. You type `allow`. You go back to sleep.

```
Boss:   Migration finished at 02:14. One step needs your sign-off.
        Triggered by: automated pipeline
        Request ID: a1b2c3
        Reply: allow a1b2c3 / deny a1b2c3

You:    allow a1b2c3

Boss:   ✅ Done. Back to sleep.
```

Or, morning:

```
You:    What shipped overnight?

Boss:   4 tasks done, 2 experiments ran, 3 scripts drafted.
        One item still pending your review.

You:    allow

Boss:   Approved. Running now.
```

You own the infra. You own the keys. Agents run on your machine, route through your Slack, and can only touch what you explicitly mount.

---

Agents run in PTY sessions managed by PM2. You talk to them from Slack. Tool calls pause and wait for `allow` or `deny`. Agents coordinate via a shared file bus, run crons automatically, and restart after crashes.

```
Slack DM / Channel
      ↓
officeOs daemon  (Node.js, PM2)
  └─ SlackControlPlane per agent  (Socket Mode)
       ├─ "allow"/"deny" → unblocks hook, resumes tool call
       └─ any message → injects into Claude PTY session
      ↑
officeos bus send-slack <channel-id> "<reply>"
```

---

## Get started  (5 minutes)

**You need:** Node.js 20+, Claude Code, PM2, a Slack app.

```bash
git clone https://github.com/reshadat/officeOs.git
cd officeOs
npm install && npm run build
npm install -g .
```

```bash
# Create org and agents
officeos install
officeos init myorg
officeos add-agent orchestrator --template orchestrator --org myorg
officeos add-agent analyst     --template analyst     --org myorg
```

```bash
# Set credentials on the orchestrator
cat > orgs/myorg/agents/orchestrator/.env << 'EOF'
SLACK_BOT_TOKEN=xoxb-...
SLACK_APP_TOKEN=xapp-...
SLACK_USER_ID=U...           # required — daemon won't start without it
SLACK_CHANNEL_ID=C...        # or SLACK_ALLOWED_CHANNELS=C...,C...
EOF
```

```bash
# Start
officeos ecosystem
pm2 start ecosystem.config.js && pm2 save && pm2 startup
```

---

## Slack app

1. [api.slack.com/apps](https://api.slack.com/apps) → Create App → **Socket Mode on** → App-Level Token (`xapp-`) with `connections:write`
2. **Bot scopes:** `channels:history`, `chat:write`, `chat:write.public`, `groups:history`, `im:history`, `im:read`, `im:write`, `channels:read`, `mpim:write`, `reactions:write`
3. **Bot events:** `message.channels`, `message.groups`, `message.im`, `member_joined_channel`
4. Install → copy Bot Token (`xoxb-`)
5. Your User ID: Profile → More → Copy Member ID

---

## Hooks

Add to orchestrator's `settings.json`:

```json
{
  "hooks": {
    "PreToolUse": [
      { "matcher": "AskUserQuestion", "hooks": [{ "type": "command", "command": "node dist/hooks/hook-ask-slack.js" }] },
      { "matcher": "ExitPlanMode",    "hooks": [{ "type": "command", "command": "node dist/hooks/hook-planmode-slack.js" }] },
      { "matcher": "*",               "hooks": [{ "type": "command", "command": "node dist/hooks/hook-permission-slack.js" }] }
    ],
    "PreCompact": [{ "type": "command", "command": "node dist/hooks/hook-compact-slack.js" }],
    "SessionEnd": [
      { "type": "command", "command": "node dist/hooks/hook-crash-alert.js" },
      { "type": "command", "command": "node dist/hooks/hook-crash-alert-slack.js" }
    ]
  }
}
```

Tool calls pause, send a Slack message, wait. Reply `allow` or `deny`. 30-minute timeout: permission hooks deny, plan hooks auto-approve.

---

## Agent config

```json
{ "enabled": true, "slack_polling": true,  "runtime": "claude-code", "model": "claude-sonnet-4-6" }
```
```json
{ "enabled": true, "slack_polling": false, "runtime": "claude-code", "model": "claude-haiku-4-5-20251001" }
```

Only the orchestrator needs `slack_polling: true`. Workers use Haiku — ~10× cheaper than Sonnet.

Turn off theta-wave on every agent (`experiments/config.json`):
```json
{ "theta_wave": { "enabled": false } }
```

---

## Security

Daemon won't start without `SLACK_USER_ID`. All trust gates are in code, not prompts.

| Env var | Who | What they can do |
|---|---|---|
| `SLACK_USER_ID` | You (owner) | Chat + approve/deny tool calls |
| `SLACK_READONLY_USERS` | Colleagues | Chat only — `allow`/`deny` silently ignored |
| *(anyone else)* | — | Completely ignored |

**Domain gating.** Set `SLACK_ALLOWED_DOMAINS=company.com`. Daemon calls `users.info` for every new sender, checks email domain, rejects on mismatch. Cached per session. Blocks guests from other workspaces.

**Channel control.** Bot ignores all channels not in `SLACK_CHANNEL_ID` / `SLACK_ALLOWED_CHANNELS`. Owner DMs always accepted. If someone other than the owner adds the bot to a channel, the bot leaves and DMs the owner.

**Outbound restriction.** Agents reply only to the channel that messaged them. Override with `SLACK_OUTBOUND_CHANNELS`.

**Approval by ID.** Each approval request has a 6-char ID. `allow abc123` approves that specific request — no race conditions when multiple tools run.

---

## Routing

Orchestrator routes to specialist agents by intent, not keywords. Register agents with a job description in `config.json`:

```json
{
  "jd": {
    "title": "Documentation Specialist",
    "description": "Finds and explains internal docs",
    "responsibilities": ["Answer questions about internal docs"],
    "provides": ["Documentation search"],
    "needs": ["Codebase context"],
    "keywords": ["docs", "wiki", "explain"]
  }
}
```

```bash
officeos sync-jds   # writes jds-registry.md to orch dir, collaborators.md to agents
officeos list-jds   # show all JDs in a table
```

Bus message protocol (daemon-level, invisible to agents):

| Message | Direction | Meaning |
|---|---|---|
| `ROUTED_QUERY: <msg>` | Orch → Agent | Handle this |
| `ROUTE_REPLY: <answer>` | Agent → Orch | Done, relay to human |
| `ROUTE_ESCALATE: <reason> \| ORIGINAL: <msg>` | Agent → Orch | Can't handle, re-route |
| `ASK_HUMAN: <question>` | Agent → Orch | Need human input |

Envelopes carry `request_id`, `origin_channel`, `hop_count`. Drops at hop 10.

---

## Threads and reactions

Replies land in the same Slack thread as the message. Thread context (up to 20 messages) injected automatically.

Agents react to messages instead of sending words where possible:

| Reaction | Meaning |
|---|---|
| 👀 `:eyes:` | Received, working |
| ✅ `:white_check_mark:` | Done |
| ❌ `:x:` | Error |

```bash
officeos bus react <channel-id> <message-ts> <emoji-name>
```

Requires `reactions:write` scope. Fails silently if omitted.

---

## CLI

```bash
officeos install             # set up state dirs
officeos init <org>          # create org
officeos add-agent <name>    # add agent  (--template, --org, --runtime)
officeos ecosystem           # generate PM2 config
officeos status              # agent health table
officeos doctor              # check prerequisites
officeos dashboard           # web dashboard  (--port 3000)
officeos sync-jds            # sync JD registry
officeos list-jds            # list agent JDs
officeos bus send-slack <channel-id> '<message>'
officeos bus react <channel-id> <message-ts> <emoji>
```

`cortextos` is a legacy alias — existing scripts still work.

---

## Docker

Limits blast radius: even if a hook fails and Claude runs unchecked, it can only touch what you mounted.

```bash
cp .env.docker.example .env          # set OPENAI_API_KEY, WORKSPACE_PATH
docker-compose up -d
docker exec -it officeos claude login # one-time OAuth
```

| Mount | Purpose |
|---|---|
| `claude-auth` volume → `/root/.claude` | Claude Code session |
| `officeos-state` volume → `/root/.officeos` | Daemon state |
| `./orgs` → `/officeos/orgs` (read-only) | Agent configs |
| `$WORKSPACE_PATH` → `/workspace` | Repo agents work on |

`~/.ssh`, `~/.aws`, host home — not mounted.

Container flags: `read_only`, `cap_drop: ALL`, `no-new-privileges`, `pids_limit: 200`, `mem_limit: 4g`.

---

## Templates

| Template | Description |
|---|---|
| `orchestrator` | Routes queries, manages goals, handles approvals |
| `analyst` | System health, metrics, JD improvement cron |
| `agent` | General-purpose worker |
| `agent-codex` | Codex runtime (`runtime: codex-app-server`) |

---

## When to skip

This is overhead for single-session use. It's for agents you want running when you're not.

If you don't want Slack, run agents headless (`slack_polling: false`) and use the file bus for inter-agent comms with no Slack integration.

---

## Requirements

| Dependency | Install |
|---|---|
| Node.js 20+ | [nodejs.org](https://nodejs.org) |
| Claude Code | `npm install -g @anthropic-ai/claude-code` + `claude login` |
| PM2 | `npm install -g pm2` |
| Slack app | See above |

---

Adapted from [cortextOS](https://github.com/grandamenium/cortextos) by grandamenium. MIT license.
