# Hermes FE Worker — runs Claude Code headless to open PRs.
# Build context = this package dir.
FROM node:22-slim

# git for clone/commit/push; ca-certificates for HTTPS to GitHub/Anthropic.
RUN apt-get update \
  && apt-get install -y --no-install-recommends git ca-certificates \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package.json ./
RUN npm install --no-audit --no-fund --omit=dev

# Claude Code CLI (the coding engine; invoked headless as `claude -p`).
RUN npm install -g @anthropic-ai/claude-code

COPY tsconfig.json ./
COPY src ./src

ENV NODE_ENV=production
CMD ["npx", "tsx", "src/index.ts"]
