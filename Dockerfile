FROM node:20-alpine

RUN apk add --no-cache \
    python3 \
    ffmpeg \
    yt-dlp

ENV PORT=48878
WORKDIR /app

# Copy dependency definitions and install fresh packages for Alpine
COPY package*.json ./
RUN npm install --omit=dev

# Copies icon.png, index.html, server.mjs (ignores secret/node_modules/server.log via .dockerignore)
COPY . .

EXPOSE ${PORT}

CMD ["node", "server.mjs"]
