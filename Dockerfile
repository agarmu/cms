FROM oven/bun:1.4.2 AS dependencies
WORKDIR /app
COPY package.json bun.lock ./
COPY apps/api/package.json ./apps/api/package.json
COPY apps/web/package.json ./apps/web/package.json
RUN bun install --frozen-lockfile --production

FROM oven/bun:1.4.2
WORKDIR /app
COPY --from=dependencies /app/node_modules ./node_modules
COPY --from=dependencies /app/apps/api ./apps/api
COPY package.json ./
COPY apps/api ./apps/api
COPY migrations ./migrations
COPY COPYING ./
USER bun
EXPOSE 3000
CMD ["bun", "apps/api/main.ts"]
