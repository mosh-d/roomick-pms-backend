# Multi-stage build. The final image carries only production dependencies plus
# the compiled output — no source, no dev toolchain, no test files.
#
# node:22 because package.json declares `"engines": { "node": ">=22" }`.
# Alpine keeps the runtime image small; `openssl` is installed explicitly
# because Prisma's query engine links against it and Alpine doesn't ship it by
# default (a Prisma-on-Alpine gotcha that surfaces as a cryptic engine load
# error at boot, not at build time).

# --- deps -------------------------------------------------------------------
FROM node:22-alpine AS deps
RUN apk add --no-cache openssl
WORKDIR /app
COPY package*.json ./
COPY prisma ./prisma
COPY prisma.config.ts ./
# `npm ci` needs the lockfile to match package.json exactly — it fails loudly
# on drift rather than silently resolving something different, which is what
# we want in a build.
RUN npm ci

# --- build ------------------------------------------------------------------
FROM node:22-alpine AS build
RUN apk add --no-cache openssl
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .
# Generate the Prisma client against the schema before compiling — the
# TypeScript build imports types from it.
RUN npx prisma generate
RUN npm run build
# Drop dev dependencies from this layer's node_modules so the runtime stage can
# copy a production-only tree without a second install.
RUN npm prune --omit=dev

# --- runtime ----------------------------------------------------------------
FROM node:22-alpine AS runtime
RUN apk add --no-cache openssl
WORKDIR /app
ENV NODE_ENV=production

# Run as the image's built-in non-root user rather than root.
USER node

COPY --from=build --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/dist ./dist
COPY --from=build --chown=node:node /app/package.json ./package.json
# Migrations and schema ship with the image so `prisma migrate deploy` can run
# as a release step against the production database.
COPY --from=build --chown=node:node /app/prisma ./prisma
COPY --from=build --chown=node:node /app/prisma.config.ts ./prisma.config.ts

# Documented only — the app reads PORT from the environment (main.ts), and
# Render/Railway inject their own. EXPOSE does not bind anything.
EXPOSE 3000

CMD ["node", "dist/main"]
