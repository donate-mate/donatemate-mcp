param([string]$url)
& wsl bash -c "node /mnt/c/Users/ashee/OneDrive/Documents/projects/DonateMate/repos/donatemate-mcp/packages/mcp-client/mcp-websocket-bridge.mjs '$url' 2>/tmp/mcp-bridge-debug.log"
