#!/bin/bash

# Configuration
REMOTE_USER="ubuntu"
REMOTE_HOST="140.245.127.64"
SSH_KEY="/Users/tonypham/MEGA/WebApp/the-second-brain/Secrets/oracle-advanced-compute/ssh-key-2026-05-29.key"
REMOTE_DIR="/home/ubuntu/agy-bridge"

echo "=== Deploying AGY Bridge to Remote Server ==="
echo "Target: $REMOTE_USER@$REMOTE_HOST:$REMOTE_DIR"
echo "---------------------------------------------"

# Create remote directories
ssh -i "$SSH_KEY" "$REMOTE_USER@$REMOTE_HOST" "mkdir -p $REMOTE_DIR/wrappers $REMOTE_DIR/public"

# Copy package.json, server.js, mcp_server.js
scp -i "$SSH_KEY" package.json server.js mcp_server.js "$REMOTE_USER@$REMOTE_HOST:$REMOTE_DIR/"

# Copy wrappers
scp -i "$SSH_KEY" wrappers/node_wrapper.js wrappers/python_wrapper.py "$REMOTE_USER@$REMOTE_HOST:$REMOTE_DIR/wrappers/"

# Copy public assets (Playground UI)
scp -i "$SSH_KEY" public/index.html "$REMOTE_USER@$REMOTE_HOST:$REMOTE_DIR/public/"

# Install dependencies on the remote server
echo "Installing dependencies on remote server..."
ssh -i "$SSH_KEY" "$REMOTE_USER@$REMOTE_HOST" "cd $REMOTE_DIR && npm install"

echo "---------------------------------------------"
echo "✅ Deployment completed successfully!"
echo "To run the Web API Server:"
echo "  ssh -i $SSH_KEY $REMOTE_USER@$REMOTE_HOST 'cd $REMOTE_DIR && npm run start:api'"
echo "To run the MCP Server:"
echo "  ssh -i $SSH_KEY $REMOTE_USER@$REMOTE_HOST 'cd $REMOTE_DIR && npm run start:mcp'"
