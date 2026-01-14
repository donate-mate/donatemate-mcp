@echo off
setlocal EnableDelayedExpansion
set "URL=%~1"
wsl bash -c "node /mnt/c/Users/ashee/OneDrive/Documents/projects/DonateMate/repos/donatemate-mcp/packages/mcp-client/mcp-websocket-bridge.mjs '!URL!' 2>/tmp/mcp-bridge-debug.log"
