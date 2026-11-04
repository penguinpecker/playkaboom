# kaboom-web on Railway. apps/web/railway.json points here; the build context
# is the REPO ROOT (npm workspaces), filtered by the root .dockerignore.
FROM node:22-bookworm-slim

WORKDIR /app

# Railway hands service variables to a Dockerfile build only when they are
# declared as ARG. `next build` inlines these into the browser bundle, so they
# must be present at BUILD time (changing one needs a rebuild, not a restart).
# Never put a secret in a NEXT_PUBLIC_* variable.
ARG NEXT_PUBLIC_SOLANA_CLUSTER
ARG NEXT_PUBLIC_PROGRAM_ID
ARG NEXT_PUBLIC_PRIVY_APP_ID
ARG NEXT_PUBLIC_ER_RPC
ARG NEXT_PUBLIC_ER_WS
ARG NEXT_PUBLIC_REALTIME_WS_URL
ARG NEXT_PUBLIC_VRF_QUEUE
ARG NEXT_PUBLIC_BUILD_ID

COPY . .

# Install only the web workspace's dependency tree (it pulls in packages/sdk
# and packages/shared), then build only the web app.
RUN npm ci --workspace=@playkaboom/web \
 && npm run build --workspace=@playkaboom/web \
 && npm cache clean --force

ENV NODE_ENV=production
WORKDIR /app/apps/web
# `next start` listens on $PORT (Railway sets it) on all interfaces. Run node
# directly (no npm wrapper) so Railway's SIGTERM reaches the server.
CMD ["node", "/app/node_modules/next/dist/bin/next", "start"]
