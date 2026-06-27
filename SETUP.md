# Setup

The fastest path is the wizard:

```bash
officeos onboard
```

It runs everything below — dependency checks, org/team creation, Slack credentials, hook wiring, JD sync, and daemon start — interactively. This guide documents the manual steps the wizard automates, plus the Slack app setup you do once in the Slack admin UI.

## Requirements

| | Install |
|---|---|
| Node.js 20+ | [nodejs.org](https://nodejs.org) |
| Claude Code | `npm install -g @anthropic-ai/claude-code && claude login` |
| PM2 | `npm install -g pm2` |
| Slack app | see below |
| Codex | optional — `npm install -g @openai/codex && codex login` |
| headroom | optional — `npm install -g headroom` — 60-90% token reduction, auto-activates |

## Install

```bash
git clone https://github.com/reshadat/officeOs.git
cd officeOs
npm install && npm run build
npm install -g .
```

## Create your first team

```bash
officeos install
officeos init myorg
officeos add-agent orchestrator --template orchestrator --org myorg
officeos add-agent analyst     --template analyst     --org myorg
```

## Credentials

```bash
cat > orgs/myorg/agents/orchestrator/.env << 'EOF'
SLACK_BOT_TOKEN=xoxb-...
SLACK_APP_TOKEN=xapp-...
SLACK_USER_ID=U...           # required — daemon won't start without it
SLACK_CHANNEL_ID=C...        # or SLACK_ALLOWED_CHANNELS=C...,C...
# SLACK_READONLY_USERS=U...,U...     # can chat, cannot approve/deny
# SLACK_ALLOWED_DOMAINS=company.com  # block guests from other workspaces
# SLACK_OUTBOUND_CHANNELS=C...,C...  # override outbound allowlist
EOF
```

## Start

```bash
officeos ecosystem
pm2 start ecosystem.config.js && pm2 save && pm2 startup
```

---

## Slack app

1. [api.slack.com/apps](https://api.slack.com/apps) → Create App → Socket Mode on → App-Level Token (`xapp-`) with `connections:write`
2. Bot scopes: `channels:history`, `chat:write`, `chat:write.public`, `groups:history`, `im:history`, `im:read`, `im:write`, `channels:read`, `mpim:write`, `reactions:write`
3. Bot events: `message.channels`, `message.groups`, `message.im`, `member_joined_channel`
4. Install → copy Bot Token (`xoxb-`)
5. Your User ID: Profile → More → Copy Member ID (`U...`)
6. Channel ID: right-click channel → Copy link → extract `C...` segment

---

## Hooks

Add to orchestrator's `.claude/settings.json`:

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

Tool calls pause, send a Slack message, wait for `allow <id>` or `deny <id>`. 30-minute timeout: permission hooks deny, plan hooks auto-approve.

---

## Agent config

Orchestrator (`config.json`):
```json
{ "enabled": true, "slack_polling": true, "runtime": "claude-code", "model": "claude-sonnet-4-6" }
```

Worker agent:
```json
{ "enabled": true, "slack_polling": false, "runtime": "claude-code", "model": "claude-haiku-4-5-20251001" }
```

Only the orchestrator needs `slack_polling: true`. Workers use Haiku — ~10× cheaper than Sonnet.

Theta-wave off (saves tokens on idle cycles) — add to each agent dir:
```bash
mkdir -p experiments
echo '{"theta_wave":{"enabled":false}}' > experiments/config.json
```

headroom — disable per-agent if needed:
```json
{ "headroom": { "enabled": false } }
```

---

## Agent job descriptions

Each agent declares what it does in `config.json` under `jd`:

```json
{
  "jd": {
    "title": "Documentation Specialist",
    "description": "Finds and explains internal documentation",
    "responsibilities": ["Answer questions about internal docs", "Explain how systems work"],
    "provides": ["Documentation search", "URL summarization"],
    "needs": ["Codebase context"],
    "keywords": ["docs", "wiki", "how-to", "explain"],
    "out_of_scope": ["Code changes", "Deployments"]
  }
}
```

After filling JD blocks:

```bash
officeos sync-jds   # writes jds-registry.md to orch dir, collaborators.md to matched agents
officeos list-jds   # show all JDs in a table
```

Orchestrator reads the registry and routes by intent, not keyword lookup. "How does the auth module work?" routes to the codebase agent because its responsibility is "explain internal code behavior" — even if "auth" isn't in its keywords.

---

## Docker

Limits blast radius. Even if a hook fails and an agent runs unchecked, it can only touch what you mounted.

```bash
cp .env.docker.example .env
docker-compose up -d

# One-time auth
docker exec -it officeos claude login
docker exec -it officeos codex login   # optional
```

| Mount | Purpose |
|---|---|
| `claude-auth` volume → `/root/.claude` | Claude Code session |
| `codex-auth` volume → `/root/.codex` | Codex session |
| `officeos-state` volume → `/root/.officeos` | Daemon state |
| `./orgs` → `/officeos/orgs` (read-only) | Agent configs |
| `$WORKSPACE_PATH` → `/workspace` | Repo agents work on |

`~/.ssh`, `~/.aws`, host home — not mounted.

Security flags: `read_only`, `cap_drop: ALL`, `no-new-privileges`, `pids_limit: 512`, `mem_limit: ${MEM_LIMIT:-4g}`, `cpus: ${CPU_LIMIT:-2.0}`.

---

## CLI reference

```bash
officeos onboard             # interactive Slack-first wizard (recommended)
officeos install             # set up state dirs
officeos init <org>          # create org
officeos add-agent <name>    # add agent (--template, --org, --runtime)
officeos ecosystem           # generate PM2 config
officeos status              # agent health table
officeos doctor              # check prerequisites
officeos dashboard           # web dashboard (--port 3000)
officeos sync-jds            # sync JD registry
officeos list-jds            # list agent JDs
officeos bus send-slack <channel-id> '<message>' [--thread-ts <ts>]
officeos bus react <channel-id> <message-ts> <emoji>
```

`cortextos` is a legacy alias — existing scripts still work.

---

## Security reference

All trust gates are in code, not prompts.

| Env var | Who | Can do |
|---|---|---|
| `SLACK_USER_ID` | You (owner) | Chat + approve/deny. Required. |
| `SLACK_READONLY_USERS` | Colleagues | Chat only — `allow`/`deny` silently ignored |
| *(anyone else)* | — | Completely ignored |

**Domain gating** — `SLACK_ALLOWED_DOMAINS=company.com` calls `users.info` on every new sender, rejects email domain mismatches. Cached per session.

**Channel control** — bot ignores channels not in `SLACK_CHANNEL_ID` / `SLACK_ALLOWED_CHANNELS`. If a non-owner adds the bot to a channel, it immediately leaves and DMs the owner.

**Outbound restriction** — agents reply only to the channel that messaged them. Override: `SLACK_OUTBOUND_CHANNELS=C123,C456`.

**Approval IDs** — each approval request has a 6-char ID. `allow abc123` targets that specific request. Bare `allow`/`deny` still works as single-agent fallback.

---

## Routing protocol

Bus message prefixes (daemon-level, invisible to agents):

| Message | Direction | Meaning |
|---|---|---|
| `ROUTED_QUERY: <msg>` | Orch → Agent | Handle this |
| `ROUTE_REPLY: <answer>` | Agent → Orch | Done, relay to human |
| `ROUTE_ESCALATE: <reason> \| ORIGINAL: <msg>` | Agent → Orch | Outside my scope |
| `ASK_HUMAN: <question>` | Agent → Orch | Need human input |

Envelopes carry `request_id`, `origin_channel`, `hop_count`. Drops at hop 10.

---

## Templates

| Template | Role |
|---|---|
| `orchestrator` | Officer — routes queries, manages human approval loop |
| `analyst` | System health, metrics, weekly JD improvement proposals |
| `agent` | General-purpose specialist (Claude Code) |
| `agent-codex` | Codex-runtime worker |
