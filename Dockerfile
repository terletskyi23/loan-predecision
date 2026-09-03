# syntax=docker/dockerfile:1

# Multi-stage so the runtime image carries no compiler, no dev dependencies and
# no test code. Three stages rather than two because the dependency install is
# the slowest layer and it should not be invalidated by a source edit.

# ---------------------------------------------------------------- dependencies
FROM node:22-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci

# ---------------------------------------------------------------------- build
FROM node:22-alpine AS build
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY package.json package-lock.json tsconfig.json tsconfig.build.json ./
COPY src ./src
RUN npm run build

# -------------------------------------------------------------- runtime deps
FROM node:22-alpine AS prod-deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

# -------------------------------------------------------------------- runtime
FROM node:22-alpine AS runtime
WORKDIR /app

# tini reaps children and forwards signals. src/index.ts handles SIGTERM to
# close the server before exiting, and a Node process running as PID 1 without
# an init cannot be relied on to receive it — which turns every deploy into a
# hard kill of in-flight requests.
RUN apk add --no-cache tini

ENV NODE_ENV=production

COPY --from=prod-deps /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY package.json ./

# The policy directory is runtime data, not build output: POLICY_VERSION names a
# file the process loads and validates at boot, and old versions are never
# deleted because replay loads the version a decision was made under (ADR-0005).
COPY policies ./policies

# node:alpine ships an unprivileged `node` user. Running as root would mean a
# code-execution bug in a dependency owns the container.
USER node

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=3s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/health/live').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "dist/index.js"]
