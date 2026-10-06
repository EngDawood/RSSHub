// Minimal stateless MCP server over Streamable HTTP (JSON responses only, no SSE).
// https://modelcontextprotocol.io/specification/2025-06-18/basic/transports#streamable-http

import type { Context, Hono } from 'hono';

import logger from '@/utils/logger';

import { callTool, listTools } from './tools';

const SUPPORTED_PROTOCOL_VERSIONS = ['2025-06-18', '2025-03-26', '2024-11-05'];

const INSTRUCTIONS = 'RSSHub turns websites into feeds. Use radar_lookup when you have a website URL, search_routes or get_namespace to discover routes, then fetch_feed with a route path to read the latest items.';

type JsonRpcMessage = {
    jsonrpc?: string;
    id?: string | number | null;
    method?: string;
    params?: Record<string, any>;
};

const rpcError = (id: JsonRpcMessage['id'], code: number, message: string) => ({ jsonrpc: '2.0', id: id ?? null, error: { code, message } });

const handleMessage = async (message: JsonRpcMessage, ctx: Context, app: Hono<any>) => {
    if (!message || typeof message !== 'object' || message.jsonrpc !== '2.0' || typeof message.method !== 'string') {
        return rpcError(message?.id, -32600, 'Invalid Request');
    }
    // Notifications (e.g. notifications/initialized) have no id and get no response
    if (message.id === undefined) {
        return;
    }
    const { id, method, params } = message;

    switch (method) {
        case 'initialize': {
            const requested = params?.protocolVersion;
            return {
                jsonrpc: '2.0',
                id,
                result: {
                    protocolVersion: SUPPORTED_PROTOCOL_VERSIONS.includes(requested) ? requested : SUPPORTED_PROTOCOL_VERSIONS[0],
                    capabilities: { tools: { listChanged: false } },
                    serverInfo: { name: 'rsshub', title: 'RSSHub', version: '1.0.0' },
                    instructions: INSTRUCTIONS,
                },
            };
        }
        case 'ping':
            return { jsonrpc: '2.0', id, result: {} };
        case 'tools/list':
            return { jsonrpc: '2.0', id, result: { tools: listTools() } };
        case 'tools/call': {
            let env: unknown;
            try {
                env = ctx.env;
            } catch {
                // ctx.env is unavailable outside Workers in some adapters
            }
            const result = await callTool(params?.name, params?.arguments, { app, origin: new URL(ctx.req.url).origin, env });
            return result ? { jsonrpc: '2.0', id, result } : rpcError(id, -32602, `Unknown tool: ${params?.name}`);
        }
        default:
            return rpcError(id, -32601, `Method not found: ${method}`);
    }
};

export const createMcpHandler = (app: Hono<any>) => async (ctx: Context) => {
    ctx.header('Cache-Control', 'no-store');
    if (ctx.req.method !== 'POST') {
        // Stateless server: no SSE stream and no sessions to delete
        ctx.header('Allow', 'POST');
        return ctx.json(rpcError(null, -32000, 'Method not allowed. Send JSON-RPC messages with POST.'), 405);
    }

    let body: JsonRpcMessage | JsonRpcMessage[];
    try {
        body = await ctx.req.json();
    } catch {
        return ctx.json(rpcError(null, -32700, 'Parse error'), 400);
    }

    try {
        if (Array.isArray(body)) {
            const responses = (await Promise.all(body.map((message) => handleMessage(message, ctx, app)))).filter(Boolean);
            return responses.length ? ctx.json(responses) : ctx.body(null, 202);
        }
        const response = await handleMessage(body, ctx, app);
        return response ? ctx.json(response) : ctx.body(null, 202);
    } catch (error) {
        logger.error(`MCP request failed: ${error instanceof Error ? error.stack : error}`);
        return ctx.json(rpcError(Array.isArray(body) ? null : body?.id, -32603, 'Internal error'), 500);
    }
};
