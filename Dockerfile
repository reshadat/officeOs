FROM node:20-slim

# Build tools for node-pty native module
RUN apt-get update && apt-get install -y \
    python3 make g++ git curl \
    && rm -rf /var/lib/apt/lists/*

# Install both agent runtimes
RUN npm install -g \
    @anthropic-ai/claude-code \
    @openai/codex

WORKDIR /officeos

# Dependencies first (layer cache)
COPY package*.json ./
RUN npm ci --ignore-scripts && npm rebuild node-pty

# Source + build
COPY . .
RUN npm run build

# State dir — overridden by named volume at runtime
RUN mkdir -p /root/.officeos/default/state

# Outbound only: Anthropic API, OpenAI API, Slack API
# No ports exposed — Socket Mode is outbound WebSocket

ENV CTX_ROOT=/root/.officeos/default
ENV NODE_ENV=production

# Daemon is PID 1 — Docker handles restarts
ENTRYPOINT ["node", "dist/daemon.js"]
