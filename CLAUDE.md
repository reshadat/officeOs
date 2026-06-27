# officeOs — Contributing

## Development Setup

```bash
git clone https://github.com/reshadat/officeOs.git
cd officeOs
npm install
npm run build
npm test
```

## Before Submitting Changes

1. `npm run build` — TypeScript must compile cleanly
2. `npm test` — all tests must pass
3. Match existing patterns in `src/` for new features
4. Add unit tests in `tests/` for any new code

## Project Structure

- `src/` — TypeScript source (bus, cli, daemon, hooks, types, utils)
- `bus/` — Shell wrapper scripts (delegate to `dist/cli.js bus`)
- `dashboard/` — Next.js 14 web dashboard
- `templates/` — Agent templates (agent, orchestrator, analyst)
- `community/` — Community skills and agent catalog
- `tests/` — Unit, integration, and E2E tests

## Code Style

- TypeScript strict mode
- No external runtime dependencies beyond what's in `package.json`
- File operations use atomic writes (see `src/utils/atomic.ts`)
- All bus operations go through `src/bus/` modules

---

# officeOs Development Guide

## Architecture

officeOs runs persistent AI agent teams controlled from Slack (or Telegram).

- **Orchestrator** = the Officer. Human-facing only. Routes queries, never does domain work.
- **Agents** = Specialists. Declare job descriptions. Handle only their JD scope.
- **Analyst** = System optimizer. Reads interaction logs, proposes JD improvements weekly.
- **Daemon** = Node.js process (PM2-managed). Runs agents in PTY sessions, manages bus.

## Routing Protocol

Agents communicate via bus message files with prefixes:
- `ROUTED_QUERY: <msg>` — Orch → Agent: handle this
- `ROUTE_REPLY: <answer>` — Agent → Orch: here is my answer
- `ROUTE_ESCALATE: <reason> | ORIGINAL: <msg>` — Agent → Orch: outside my scope
- `ASK_HUMAN: <question>` — Agent → Orch: need human input

Orch handles `ASK_HUMAN` by forwarding to Slack/Telegram, waiting for owner reply, relaying back.

Bus messages carry an invisible envelope: `request_id`, `origin_channel`, `hop_count` (drop at 10).

## JD System

Agents declare responsibilities in `config.json → jd`. Run `officeos sync-jds` after changes.
Registry lands at `orgs/<org>/agents/<orch>/jds-registry.md`.
Collaborator maps land at `orgs/<org>/agents/<agent>/memory/collaborators.md`.

## Security

- `SLACK_USER_ID` required — daemon refuses to start without it
- Approval IDs: hooks include a 6-char shortId; owner types `allow a1b2c3` not bare `allow`
- send-slack restricted to origin channel by default; override via `SLACK_OUTBOUND_CHANNELS`
- Agents rate-limited by default (10 msg/60s for readonly users)
- Auto-eject if bot added to channel by non-owner

## Headroom

If `headroom` binary is installed (`npm install -g headroom`), it auto-activates and compresses
tool outputs 60-90%. Disable per-agent: `"headroom": { "enabled": false }` in config.json.

## Adding Features

1. `npm run build` must pass with zero TS errors
2. Add unit tests in `tests/` for new code
3. Match patterns in `src/` — atomic file writes, no external runtime dependencies
4. No company-specific content in templates — this is open source

## Branch Strategy

- `main` — stable
- `feature/security-fixes` — security patches (merge first)
- `feature/slack-ux` — threading, reactions, approval IDs
- `feature/headroom` — token compression
- `feature/jd-registry` — JD routing system
