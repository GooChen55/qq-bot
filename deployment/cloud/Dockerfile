FROM node:22-bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends git ca-certificates ffmpeg python3 && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts --no-audit --no-fund
COPY deployment ./deployment
COPY shared ./shared
COPY debate ./debate
COPY bot3 ./bot3
COPY bot4 ./bot4
COPY bot5 ./bot5
COPY bot6 ./bot6
RUN for bot in bot3 bot4 bot5 bot6; do npm ci --prefix "$bot" --no-audit --no-fund; done
ENV QQBOT_ROOT=/app QQBOT_PANEL_HOST=0.0.0.0 QQBOT_DEPLOY_CONFIG=/config/config.json
EXPOSE 9990
CMD ["node","deployment/cli.mjs","start"]
