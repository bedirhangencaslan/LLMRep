FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production PORT=8787 DB_PATH=/app/data/llmrep.db
COPY package.json ./
COPY server ./server
COPY public ./public
COPY client ./client
COPY *.md ./
RUN mkdir -p /app/data && chown -R node:node /app
USER node
EXPOSE 8787
VOLUME ["/app/data"]
HEALTHCHECK --interval=60s --timeout=5s CMD wget -qO- --header="User-Agent: healthcheck-probe/1.0 (docker)" http://127.0.0.1:8787/api/health || exit 1
CMD ["node", "--disable-warning=ExperimentalWarning", "server/index.js"]
