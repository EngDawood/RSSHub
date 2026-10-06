import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

process.env.NODE_NAME = 'mock';

const rpc = (app, body, headers: Record<string, string> = {}) =>
    app.request('/mcp', {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...headers },
        body: JSON.stringify(body),
    });

const callTool = async (app, name: string, args: Record<string, unknown>) => {
    const response = await rpc(app, { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } });
    const data = await response.json();
    return { isError: data.result.isError, payload: data.result.isError ? data.result.content[0].text : JSON.parse(data.result.content[0].text) };
};

beforeEach(() => {
    delete process.env.ACCESS_KEY;
});

afterEach(() => {
    delete process.env.ACCESS_KEY;
    vi.resetModules();
});

describe('mcp', () => {
    it('initializes and lists tools', async () => {
        const app = (await import('@/app')).default;

        const init = await rpc(app, { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'test', version: '1' } } });
        expect(init.status).toBe(200);
        const initData = await init.json();
        expect(initData.result.protocolVersion).toBe('2025-03-26');
        expect(initData.result.capabilities.tools).toBeDefined();

        const notification = await rpc(app, { jsonrpc: '2.0', method: 'notifications/initialized' });
        expect(notification.status).toBe(202);

        const list = await (await rpc(app, { jsonrpc: '2.0', id: 2, method: 'tools/list' })).json();
        expect(list.result.tools.map((tool) => tool.name)).toEqual(['search_routes', 'get_namespace', 'fetch_feed', 'radar_lookup']);
    });

    it('handles protocol errors', async () => {
        const app = (await import('@/app')).default;

        expect((await app.request('/mcp')).status).toBe(405);

        const parseError = await app.request('/mcp', { method: 'POST', body: '{' });
        expect((await parseError.json()).error.code).toBe(-32700);

        const unknownMethod = await (await rpc(app, { jsonrpc: '2.0', id: 1, method: 'nope' })).json();
        expect(unknownMethod.error.code).toBe(-32601);

        const unknownTool = await (await rpc(app, { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'nope' } })).json();
        expect(unknownTool.error.code).toBe(-32602);
    });

    it('searches routes and reads namespaces', async () => {
        const app = (await import('@/app')).default;

        const search = await callTool(app, 'search_routes', { query: 'github issue' });
        expect(search.payload.routes.some((route) => route.path.startsWith('/github/issue'))).toBe(true);

        const namespace = await callTool(app, 'get_namespace', { namespace: 'github' });
        expect(namespace.payload.name).toBe('GitHub');
        expect(namespace.payload.routes.length).toBeGreaterThan(0);

        const missing = await callTool(app, 'get_namespace', { namespace: 'does-not-exist' });
        expect(missing.isError).toBe(true);
    });

    it('fetches a feed', async () => {
        const app = (await import('@/app')).default;

        const feed = await callTool(app, 'fetch_feed', { path: '/test/1', limit: 2 });
        expect(feed.isError).toBeFalsy();
        expect(feed.payload.title).toBe('Test 1');
        expect(feed.payload.items).toHaveLength(2);
        expect(feed.payload.items[0].title).toBeDefined();

        const badPath = await callTool(app, 'fetch_feed', { path: 'https://example.com' });
        expect(badPath.isError).toBe(true);

        const error = await callTool(app, 'fetch_feed', { path: '/test/error' });
        expect(error.isError).toBe(true);
    });

    it('looks up radar rules', async () => {
        const app = (await import('@/app')).default;

        const result = await callTool(app, 'radar_lookup', { url: 'https://github.com/DIYgod/RSSHub/issues' });
        expect(result.payload.matches.some((match) => match.path === '/github/issue/DIYgod/RSSHub')).toBe(true);

        const invalid = await callTool(app, 'radar_lookup', { url: 'not a url' });
        expect(invalid.isError).toBe(true);
    });

    it('accepts the access key from query or headers', async () => {
        const key = '1L0veRSSHub';
        process.env.ACCESS_KEY = key;
        const app = (await import('@/app')).default;
        const ping = { jsonrpc: '2.0', id: 1, method: 'ping' };

        expect((await rpc(app, ping)).status).toBe(403);
        expect((await rpc(app, ping, { authorization: 'Bearer wrong' })).status).toBe(403);

        const keyHeaders: Array<Record<string, string>> = [{ authorization: `Bearer ${key}` }, { 'api-key': key }, { 'x-api-key': key }];
        for (const headers of keyHeaders) {
            // oxlint-disable-next-line no-await-in-loop
            expect((await rpc(app, ping, headers)).status).toBe(200);
        }
        const query = await app.request(`/mcp?key=${key}`, { method: 'POST', body: JSON.stringify(ping) });
        expect(query.status).toBe(200);

        // fetch_feed forwards the key to the internal route request
        const response = await app.request(`/mcp?key=${key}`, {
            method: 'POST',
            body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'fetch_feed', arguments: { path: '/test/1' } } }),
        });
        const data = await response.json();
        expect(data.result.isError).toBeFalsy();
    });
});
