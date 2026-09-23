# Connecta application server (backend + web PWA).
# Build from the repository root:  docker build -t connecta .
FROM node:20-alpine AS build
WORKDIR /app

# Install server dependencies (better-sqlite3 ships prebuilt binaries for alpine/musl).
COPY server/package.json server/package-lock.json* ./server/
RUN cd server && npm install --omit=dev

FROM node:20-alpine
WORKDIR /app
ENV NODE_ENV=production

COPY --from=build /app/server/node_modules ./server/node_modules
COPY server/package.json ./server/
COPY server/src ./server/src
# The server statically serves the shared client + PWA shell.
COPY desktop/renderer ./desktop/renderer
COPY web ./web

EXPOSE 4000
CMD ["node", "server/src/index.js"]
