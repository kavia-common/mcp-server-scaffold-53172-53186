#!/bin/bash
cd /home/kavia/workspace/code-generation/mcp-server-scaffold-53172-53186/mcp_server_backend
npm run lint
LINT_EXIT_CODE=$?
if [ $LINT_EXIT_CODE -ne 0 ]; then
  exit 1
fi

