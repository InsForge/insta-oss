#!/bin/bash
# Minimal streamable-HTTP MCP client: initialize, then one JSON-RPC call.
TOK=insta_bbytNwJxedSOEQNWyHJgnYrCuBVtvxrtFeQDXJRurcbvdhCQoPpWBzJnrBFJCEiP
URL=http://127.0.0.1:8899/mcp
BODY=${1:?json-rpc body}
curl -sS -m 60 -D /tmp/mcp-headers.txt \
  -H "authorization: Bearer $TOK" \
  -H 'content-type: application/json' \
  -H 'accept: application/json, text/event-stream' \
  -H 'mcp-protocol-version: 2025-06-18' \
  -d "$BODY" "$URL"
