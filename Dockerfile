FROM node:20-alpine

# Install system dependencies (including curl/ca-certificates)
RUN apk add --no-cache \
    python3 \
    ffmpeg \
    curl \
    ca-certificates

# Install standalone yt-dlp binary with self-update support
RUN curl -L https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp -o /usr/local/bin/yt-dlp \
    && chmod a+rx /usr/local/bin/yt-dlp

ENV PORT=48878
WORKDIR /app

COPY package*.json ./
RUN npm install --omit=dev

COPY . .

EXPOSE ${PORT}

CMD ["node", "server.mjs"]
