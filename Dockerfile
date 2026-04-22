# poker-server Dockerfile — local reproduction of the Railway build.
#
# Railway deploys this service using nixpacks.toml (see sibling file). The
# Nix-based Railway build is authoritative for production. This Dockerfile
# exists ONLY so developers can build/run the service locally in a Docker
# environment identical to prod without needing a Railway plan, and so CI
# or incident-response tooling can spin up a short-lived replica.
#
# Keep the tools/version pins here in lock-step with nixpacks.toml. If
# Railway's build ever diverges (different node, different libc), compile
# native modules against whatever Railway uses and paste the issue in
# SITES.md known-issues.

FROM node:20-alpine

# Native-compile toolchain for any deps that need it (poker-server itself
# doesn't use canvas, but transitively a future dep might).
RUN apk add --no-cache python3 make g++

WORKDIR /app

COPY package*.json ./
# npm ci matches the lockfile exactly — same discipline as the CI workflow.
# CLAUDE.md rule: always commit package.json + package-lock.json together
# so this step doesn't surprise-fail. The earlier Railway outage (2026-04-22)
# was caused by a lockfile mismatch; the pre-push git hook now blocks that.
RUN npm ci --no-audit --no-fund

COPY . .

RUN npm run build

ENV NODE_ENV=production
# Railway sets this; default is dev-friendly.
ENV LOG_LEVEL=info

# Matches `npm start` in package.json — `node dist/index.js`
CMD ["node", "dist/index.js"]
