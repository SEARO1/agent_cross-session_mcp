#!/usr/bin/env node
/**
 * cross-session — an MCP server that lets DSH agent sessions see each other.
 *
 * This file is only the stdio transport; the tool surface lives in
 * {@link module:cross-session/tools} so it can be tested without a transport.
 *
 * Environment:
 * - `DSH_HOME` / `DSH_SESSIONS_DIR` — where session logs live.
 * - `CROSS_SESSION_BOARD` — board file path.
 * - `CROSS_SESSION_SERVER_NAME` — MCP server name (default `crosssession`),
 *   which must match the `serverName` in the DSH MCP registration.
 *
 * @module cross-session/server
 */
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { boardFile } from './lib/board.mjs';
import { sessionsRoot } from './lib/session-logs.mjs';
import { SERVER_NAME, SERVER_VERSION, TOOLS, callTool } from './lib/tools.mjs';

const server = new Server(
  { name: 'cross-session', version: SERVER_VERSION },
  {
    capabilities: { tools: {} },
    instructions:
      'Cross-session awareness for DSH: call peers to see what other sessions are doing, announce to post a note, board to read notes.',
  },
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const name = request.params.name;
  const args = request.params.arguments ?? {};
  try {
    const text = await callTool(name, args);
    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return { content: [{ type: 'text', text: `cross-session ${name} failed: ${error instanceof Error ? error.message : String(error)}` }], isError: true };
  }
});

await server.connect(new StdioServerTransport());
console.error(`[cross-session] ready — serverName=${SERVER_NAME}, sessions=${sessionsRoot()}, board=${boardFile()}`);
