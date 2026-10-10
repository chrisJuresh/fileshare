# syntax=docker/dockerfile:1
# fileshare app image. Also runs the restic runner (`node dist/backup/main.js`), so it bundles
# the restic binary. glibc base (bookworm): utp-native only ships a linux-x64 glibc prebuild.
# Bump versions by changing the tag AND the digest (`docker buildx imagetools inspect <tag>`).
ARG NODE_IMAGE=node:22.23.3-bookworm-slim@sha256:c3de60bf2f9dd0ac6370e6117950ff62d6e339527e7472301c9c78a017978392
ARG RESTIC_IMAGE=restic/restic:0.19.1@sha256:136600b6ff6843d61d355f7f71f460a166429f35de6fd11b568fece3c9a4d510

# Official restic image, pinned by digest; only its static binary is used.
FROM ${RESTIC_IMAGE} AS restic

# ---- build: compile TypeScript + bundle the frontends ------------------------------------
FROM ${NODE_IMAGE} AS build
WORKDIR /app
COPY package.json package-lock.json ./
# --ignore-scripts: better-sqlite3 has a binding.gyp, so npm would compile it from source (needs
# python/g++); it ships prebuilds instead. Only esbuild needs its install step here.
RUN npm ci --no-audit --no-fund --ignore-scripts && npm rebuild esbuild
COPY tsconfig.json tsconfig.web.json ./
COPY scripts/build-web.mjs scripts/
COPY src src
COPY web web
RUN npm run build

# ---- production dependencies only ---------------------------------------------------------
# better-sqlite3, argon2 and utp-native load prebuilds bundled in their npm tarballs; only
# node-datachannel downloads its prebuild (prebuild-install, from GitHub) in its install script.
FROM ${NODE_IMAGE} AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund --ignore-scripts \
 && npm rebuild node-datachannel \
 && npm cache clean --force \
 && rm -rf node_modules/better-sqlite3/deps node_modules/better-sqlite3/src \
 && find node_modules -type d -path '*/prebuilds/*' \
      \( -name 'darwin-*' -o -name 'win32-*' -o -name 'android-*' -o -name 'freebsd-*' -o -name 'linuxmusl-*' \) \
      -prune -exec rm -rf {} + \
 && find node_modules -type f -path '*/prebuilds/*' \
      \( -name '*darwin*' -o -name '*win32*' -o -name '*musl*' \) -delete

# ---- runtime -----------------------------------------------------------------------------
FROM ${NODE_IMAGE} AS runtime
ENV NODE_ENV=production \
    RESTIC_BIN=/usr/local/bin/restic
# npm/yarn/corepack are not needed at runtime; removing them reduces the attack surface.
RUN rm -rf /usr/local/lib/node_modules/npm /usr/local/lib/node_modules/corepack \
           /usr/local/bin/npm /usr/local/bin/npx /usr/local/bin/corepack /opt/yarn-* \
           /usr/local/bin/yarn /usr/local/bin/yarnpkg
WORKDIR /app
COPY --from=restic --chown=0:0 --chmod=0755 /usr/bin/restic /usr/local/bin/restic
COPY --from=deps /app/node_modules node_modules
COPY --from=build /app/dist dist
COPY package.json ./
# Fail the build if restic or any native module can't load on this base image.
RUN restic version \
 && node --input-type=module -e "\
      const mods = ['better-sqlite3', 'argon2', 'node-datachannel', 'utp-native'];\
      for (const m of mods) await import(m);\
      const { default: Database } = await import('better-sqlite3');\
      new Database(':memory:').prepare('select 1').get();\
      console.log('native modules ok:', mods.join(', '));"
# Containers run as ${PUID}:${PGID} (compose `user:`); this is only the fallback.
USER 1000:1000
CMD ["node", "dist/main.js"]
