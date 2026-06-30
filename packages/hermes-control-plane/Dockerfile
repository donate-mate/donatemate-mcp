# Hermes Control Plane — always-on Fargate service.
# Build context = this package dir (self-contained; deps resolved from npm registry).
FROM node:22-slim

WORKDIR /app

# Install deps first for layer caching
COPY package.json ./
RUN npm install --no-audit --no-fund --omit=dev

COPY tsconfig.json ./
COPY src ./src

ENV NODE_ENV=production
ENV PORT=3000
EXPOSE 3000

# Run with tsx (matches the repo's tsx usage for the CDK app) — no separate build step.
CMD ["npx", "tsx", "src/index.ts"]
