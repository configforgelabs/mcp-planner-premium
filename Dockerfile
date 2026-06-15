# --- build stage ---
FROM node:22-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

# --- runtime stage ---
FROM node:22-slim AS runtime
ENV NODE_ENV=production

# Allow the (non-root) node binary to bind the privileged port 443 via the
# CAP_NET_BIND_SERVICE capability, instead of running as root.
RUN apt-get update \
  && apt-get install -y --no-install-recommends libcap2-bin \
  && setcap 'cap_net_bind_service=+ep' "$(readlink -f "$(command -v node)")" \
  && apt-get purge -y libcap2-bin \
  && apt-get autoremove -y \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY --chown=node:node --from=build /app/dist ./dist

# DATAVERSE_ORG_URL and TENANT_ID must be supplied at deploy time; see README.
ENV PORT=443
EXPOSE 443

# Drop root; the official node image ships a non-privileged `node` user.
USER node

# Node receives SIGTERM as PID 1 because index.ts registers explicit handlers,
# so graceful shutdown works without an init shim. For zombie reaping, run the
# container with an init process (docker `--init`, or enable it in the Azure
# Container Apps revision) - belt-and-suspenders, not required for shutdown.
CMD ["node", "dist/index.js"]
