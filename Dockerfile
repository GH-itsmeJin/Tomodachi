FROM node:22-bookworm-slim AS build

WORKDIR /app
RUN apt-get update \
  && apt-get install -y --no-install-recommends python3 make g++ \
  && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

FROM node:22-bookworm-slim AS runtime

WORKDIR /app
ENV NODE_ENV=production
ENV DATABASE_URL=/data/app.db
COPY --from=build /app/node_modules ./node_modules
COPY package.json server.js ./

VOLUME ["/data"]
EXPOSE 8000

CMD ["node", "server.js"]
