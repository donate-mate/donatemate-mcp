# Hermes FE Worker — runs Codex headless to open PRs.
# Build context = this package dir.
FROM node:22-slim

# git for clone/commit/push; awscli for backend alarm/log investigations; ca-certificates for HTTPS.
RUN apt-get update \
  && apt-get install -y --no-install-recommends git awscli ca-certificates \
  && rm -rf /var/lib/apt/lists/*

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
