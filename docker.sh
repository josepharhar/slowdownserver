#!/bin/bash
set -e
set -x

docker build -t slodown-server .

docker run -d \
  --name slodown \
  --restart unless-stopped \
  -p 48878:48878 \
  -v $(pwd)/secret:/app/secret \
  -v $(pwd)/server.log:/app/server.log \
  slodown-server
