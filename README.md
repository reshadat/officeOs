<p align="center">
  <img src="assets/logo.svg" width="560" alt="officeOs — one light always on">
</p>

<p align="center">
  <img src="https://img.shields.io/badge/license-MIT-111111?style=flat-square" alt="MIT">
  <img src="https://img.shields.io/badge/node-20%2B-111111?style=flat-square" alt="Node 20+">
  <img src="https://img.shields.io/badge/platform-macOS%20%7C%20Linux-111111?style=flat-square" alt="macOS / Linux">
  <img src="https://img.shields.io/badge/runtime-Claude%20Code%20%7C%20Codex-111111?style=flat-square" alt="Claude Code / Codex">
  <img src="https://img.shields.io/badge/Slack-Socket%20Mode-111111?style=flat-square" alt="Slack Socket Mode">
</p>

---

You are the on-call, the router, the person colleagues Slack when they don't know who else to ask. You know the codebase better than anyone because you've been paged about it at every hour. You handle the overnight jobs because nobody else has context. You write the status updates. You approve the deploys.

officeOs builds you a team to handle that.

An orchestrator who reads every agent's job description and routes without asking you. An analyst who watches your systems so you stop waking up to surprises. Specialists who know their domain, hand off what isn't theirs, and surface only the decisions that actually need a human.

They live on your infra. They talk through your Slack. The keys stay with you.

```
You:    What shipped overnight?

Chief:  Overnight summary:
        · Analyst ran nightly metrics — no anomalies
        · Codebase agent answered 3 questions from the team
        · Deploy pipeline ran at 02:14, one approval pending

You:    allow

Chief:  ✅ Deploy complete. Everything green.
```

```
Colleague (Slack):  How does the rate limiter work?

Chief:  Routing to codebase agent.
        Rate limiter: token-bucket. 10 req/60s per user, 100 req/60s global.
        Config: src/middleware/rate-limit.ts
```

```
Boss:   Migration needs your sign-off.
        File: /workspace/db/migrations/0042_users.sql
        Triggered by: deploy pipeline
        Request ID: a1b2c3
        Reply: allow a1b2c3 / deny a1b2c3

You:    allow a1b2c3

Boss:   ✅ Done. Back to sleep.
```

Your team, your infra. Agents run on your machine, talk through your Slack, and can only touch what you explicitly give them. The keys are yours.

## How it works

Every agent declares a job description — what it handles, what it provides, what's out of scope. The orchestrator reads all of them on every query and routes by intent, not keywords. "How does the auth module work?" reaches the codebase agent because its responsibility is explaining internal code, not because "auth" appears in a lookup table.

When no specialist fits, the orchestrator handles it directly or tells you one doesn't exist yet.

## Your office has departments

An org is a team. Each team has an orchestrator and a set of specialists. You talk to one Slack interface — the top-level orchestrator — and it routes to whichever team or specialist handles the work.

```
You → Slack → your-orch
                ├─ docs team
                │    ├─ doc-writer
                │    ├─ doc-reviewer
                │    └─ release-notes-agent
                └─ marketing team
                     ├─ marketing-analyst
                     └─ social-media-agent
```

```
You:       Prep the release notes for v2.4 and draft a LinkedIn post.

Chief:     Routing release notes to docs team.
           Routing LinkedIn draft to marketing.

           Release notes ready. LinkedIn draft ready.
           Both in your inbox.
```

One Slack message. Two teams. You never thought about who does what.

## Agents don't belong to teams

The codebase agent lives in the engineering org. The docs team needs it to pull technical context for release notes. The marketing team needs it to write accurate product descriptions.

Nobody spins up a second codebase agent. They use the same one.

Mark an agent as shared in its `config.json`:

```json
{
  "jd": {
    "title": "Codebase Expert",
    "shared": true
  }
}
```

Run `officeos sync-jds` and every active orchestrator gets this agent in its registry. One agent, used by the whole office.

```
marketing-orch:  need technical accuracy check on this product description
  → routes to engineering/codebase-agent (shared)
  ← "Auth flow description is correct. Performance numbers are outdated — p95 is 42ms not 80ms."
marketing-orch:  updates draft, routes to social-media-agent for formatting
```

## Delegating a team

Give Alice control of the docs team. Set her Slack user ID on the docs orchestrator and point it at a dedicated channel. She talks to `#docs-bot`. Her orch knows about all shared agents across the office — she can reach the codebase agent without coming to you.

```bash
# docs-orch .env
SLACK_BOT_TOKEN=xoxb-...        # same bot, one Slack app
SLACK_CHANNEL_ID=C_DOCS_BOT     # Alice's channel
SLACK_USER_ID=U_ALICE           # Alice approves her team's tool calls
```

Alice owns her team's approval queue. Tool calls on shared agents (codebase, release-notes) go to the agent's configured owner — the infra owner. She can't approve writes to the codebase. She shouldn't.

## Direct route vs team route

```
You:   Rewrite the intro paragraph of SETUP.md, make it shorter.
Chief: Routing to doc-writer.
       Done. 3 sentences → 1.
```

```
You:   Prep everything for the v2.4 release — notes, announcement, socials.
Chief: Routing to docs-orch for coordination.
       docs-orch is sequencing: release-notes → doc-reviewer → marketing-orch → social-media-agent.
       Will surface when ready.
```

## Setting up teams

```bash
officeos init docs
officeos add-agent docs-orch           --template orchestrator --org docs
officeos add-agent doc-writer          --template agent        --org docs
officeos add-agent release-notes-agent --template agent        --org docs

officeos init marketing
officeos add-agent marketing-orch  --template orchestrator --org marketing
officeos add-agent social-media    --template agent        --org marketing

officeos sync-jds   # propagates shared agents to all active orchestrators
```

One rule: **agent names must be unique across the whole office.** Two teams can't both have an agent named `analyst`. Use `docs-analyst` and `marketing-analyst`. The CLI enforces this.

## Install

```bash
git clone https://github.com/reshadat/officeOs.git
cd officeOs && npm install && npm run build && npm install -g .

officeos onboard
```

`officeos onboard` is an interactive wizard. It installs dependencies, creates your teams, connects Slack, wires the hooks, syncs the JD registry, and starts the daemon. It walks you through one team at a time and lets you mark shared agents as you go.

Prefer to do it by hand, or just want one agent?

```bash
officeos install
officeos init myorg
officeos add-agent orchestrator --template orchestrator --org myorg
officeos add-agent analyst     --template analyst     --org myorg
# add Slack credentials to orgs/myorg/agents/orchestrator/.env, then:
officeos ecosystem
pm2 start ecosystem.config.js && pm2 save && pm2 startup
```

→ [Full setup guide](SETUP.md) — Slack app, hooks, agent config, Docker, security.

## When to skip

This is overhead if you want a single session. It's for agents you want running when you're not.

No Slack? Run headless (`slack_polling: false`) and use the file bus for inter-agent comms.

---

MIT licensed — see [LICENSE](LICENSE).
