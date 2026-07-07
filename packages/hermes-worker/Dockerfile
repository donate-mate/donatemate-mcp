# Hermes FE Worker — runs Codex headless to open PRs.
# Build context = this package dir.
FROM node:22-slim

# git for clone/commit/push; awscli for backend alarm/log investigations; ca-certificates for HTTPS.
RUN apt-get update \
  && apt-get install -y --no-install-recommends git awscli ca-certificates \
  && rm -rf /var/lib/apt/lists/*

# WS1 — the target repo (donatemate) installs with yarn/pnpm. Enable corepack so those package
# managers are on PATH, and provide a writable warm-cache dir (HERMES_CACHE_DIR) that the nightly
# image build prebakes (yarn/npm/turbo caches) so job-time installs hit a warm cache.
RUN corepack enable \
  && mkdir -p /opt/hermes-cache/yarn /opt/hermes-cache/npm /opt/hermes-cache/turbo \
  && chown -R node:node /opt/hermes-cache
ENV HERMES_CACHE_DIR=/opt/hermes-cache

WORKDIR /app

COPY package.json ./
RUN npm install --no-audit --no-fund --omit=dev

# OpenAI Codex CLI (the coding engine; invoked headless as `codex exec`).
RUN npm install -g @openai/codex

COPY tsconfig.json ./
COPY src ./src

# Run as the non-root `node` user. /tmp (clone workspace) and /home/node (CLI config)
# are writable by this user.
RUN chown -R node:node /app
USER node
ENV HOME=/home/node
ENV NODE_ENV=production
CMD ["npx", "tsx", "src/index.ts"]
