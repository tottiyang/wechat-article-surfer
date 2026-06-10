#!/bin/bash
# Start login server and localhost.run tunnel
# Usage: ./start-login.sh

PID_FILE="/tmp/wechat-mp-client.pids"

cleanup() {
  if [ -f "$PID_FILE" ]; then
    read -r SERVER_PID TUNNEL_PID < "$PID_FILE"
    kill "$SERVER_PID" "$TUNNEL_PID" 2>/dev/null
    rm -f "$PID_FILE"
  fi
  exit 0
}
trap cleanup EXIT INT TERM

cd {managed_skill_dir}/wechat-article-surfer

# Start login server
node src/login-server.js 3000 &
SERVER_PID=$!
sleep 1

# Start SSH tunnel
ssh -o StrictHostKeyChecking=no -o ServerAliveInterval=60 \
  -R 80:localhost:3000 nokey@localhost.run 2>&1 &
TUNNEL_PID=$!

echo "$SERVER_PID $TUNNEL_PID" > "$PID_FILE"

# Wait for tunnel URL
sleep 4

# Monitor
wait
