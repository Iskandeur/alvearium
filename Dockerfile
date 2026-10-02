FROM node:22-alpine
WORKDIR /app
COPY lib ./lib
COPY server ./server
ENV PORT=8793 SESSION_BOARD_DATA=/data
EXPOSE 8793
HEALTHCHECK --interval=60s --timeout=3s CMD wget -qO- http://127.0.0.1:8793/healthz || exit 1
CMD ["node", "server/server.mjs"]
