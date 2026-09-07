# Node 22 LTS. Node 18 reached end of life in April 2025 and stopped receiving
# security patches, and the app was already being developed against 22 locally —
# so the image was both unpatched and a different runtime from the one tested.
#
# Alpine is safe here despite two native dependencies: sqlite3 6.x publishes
# napi-v6-linuxmusl prebuilds for x64 and arm64, and bcrypt 6.x ships
# bcrypt.musl.node inside the package itself. Neither compiles at build time, so
# the image needs no toolchain.
FROM node:22-alpine

WORKDIR /app

# package-lock.json is matched by the wildcard and is required by npm ci below.
COPY package*.json ./

# ci, not install. `npm install` is free to resolve a newer version than the
# lockfile pins, so the image could differ from what was tested — silently, and
# only for whoever happened to build it that day. `npm ci` installs the lockfile
# exactly, or fails.
RUN npm ci --omit=dev

COPY . .

# The analytics replica must outlive the container. It keeps execution history
# that n8n has already pruned from Postgres, so losing it means losing data that
# cannot be re-synced. Mount a named volume at /data — see README.
ENV DASHBOARD_DB_PATH=/data/dashboard.sqlite
RUN mkdir -p /data && chown -R node:node /data
VOLUME ["/data"]

EXPOSE 3000

# Run unprivileged. A dashboard that holds a database and talks to Postgres has
# no reason to be root, and root in the container is root on the /data volume.
#
# UPGRADING AN EXISTING DEPLOYMENT: Docker only applies image ownership to a
# volume it creates empty. A volume that already exists is left exactly as it is,
# so one that was written by the old root container stays root-owned and the app
# cannot open its own database. Run this ONCE before deploying this version:
#
#   docker run --rm -v <your-volume>:/data alpine chown -R 1000:1000 /data
#
# server.js checks /data on boot and fails with this instruction rather than an
# opaque SQLITE_CANTOPEN.
USER node

# Lets the orchestrator see the difference between "the process is alive" and
# "the app can actually answer". node -e rather than curl: the Alpine image has
# no curl, and adding one for a health check is a whole package of attack surface
# for something the runtime can already do.
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
    CMD node -e "fetch('http://127.0.0.1:'+(process.env.DASHBOARD_PORT||3000)+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

# --- Provenance (B-7) -------------------------------------------------------
#
# Last, and deliberately so. These change on every release while nothing above
# them does, and an ARG placed higher would invalidate the npm ci layer for a
# rebuild that differs only by tag.
#
# Only GIT_SHA becomes an ENV, because only GIT_SHA is genuinely unknowable
# from the source tree — src/utils/version.js reads it at boot. APP_VERSION is
# NOT exported: package.json is the single source of the version number, and a
# second one in the environment is how an image ends up labelled 2.1.0 while
# its own /api/version answers 2.0.0. The release workflow asserts the tag and
# package.json agree before it ever gets here.
ARG APP_VERSION=dev
ARG GIT_SHA=unknown
ENV GIT_SHA=${GIT_SHA}

LABEL org.opencontainers.image.title="n8n Analytics" \
      org.opencontainers.image.description="Analytics dashboard for self-hosted n8n" \
      org.opencontainers.image.version=${APP_VERSION} \
      org.opencontainers.image.revision=${GIT_SHA} \
      org.opencontainers.image.source=https://github.com/giorgoskoufos/n8n-analytics \
      org.opencontainers.image.licenses=MIT

CMD ["node", "server.js"]
