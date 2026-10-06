import type { Hono } from 'hono';
import { parse } from 'tldts';

import { getRadarRules } from '@/api/radar/rules/utils';
import { config } from '@/config';
import { ensureAllLoaded, namespaces } from '@/registry';

export type ToolResult = {
    content: Array<{ type: 'text'; text: string }>;
    isError?: boolean;
};

export type ToolContext = {
    app: Hono<any>;
    origin: string;
    env?: unknown;
};

type Tool = {
    name: string;
    title: string;
    description: string;
    inputSchema: Record<string, unknown>;
    annotations?: Record<string, unknown>;
    handler: (args: Record<string, any>, context: ToolContext) => Promise<unknown>;
};

const MAX_CONTENT_LENGTH = 2000;

const clampLimit = (value: unknown, fallback: number, max: number) => {
    const number = Number(value);
    return Number.isSafeInteger(number) && number > 0 ? Math.min(number, max) : fallback;
};

const truncate = (text: string | undefined, length: number) => (text && text.length > length ? `${text.slice(0, length)}...` : text);

const stripHtml = (html: string | undefined) =>
    html
        ?.replaceAll(/<(script|style)[\s\S]*?<\/\1>/gi, '')
        .replaceAll(/<[^>]+>/g, ' ')
        .replaceAll(/\s+/g, ' ')
        .trim();

const summarizeRoute = (namespace: string, path: string, route: (typeof namespaces)[string]['routes'][string]) => ({
    path: `/${namespace}${path}`,
    name: route.name,
    example: route.example,
    parameters: route.parameters,
    categories: route.categories,
    requireConfig: route.features?.requireConfig || undefined,
    requirePuppeteer: route.features?.requirePuppeteer || undefined,
});

const searchRoutes: Tool = {
    name: 'search_routes',
    title: 'Search routes',
    description: 'Search RSSHub routes by keyword (site name, namespace, route name or category). Returns route paths with their parameters and a working example path that can be passed to fetch_feed.',
    inputSchema: {
        type: 'object',
        properties: {
            query: { type: 'string', description: 'Keywords, e.g. "github issue" or "youtube channel"' },
            limit: { type: 'integer', description: 'Maximum number of routes to return (default 20, max 50)', minimum: 1, maximum: 50 },
        },
        required: ['query'],
    },
    annotations: { readOnlyHint: true, openWorldHint: false },
    handler: async ({ query, limit }) => {
        if (typeof query !== 'string' || !query.trim()) {
            throw new Error('`query` must be a non-empty string.');
        }
        await ensureAllLoaded();
        const words = query.toLowerCase().split(/\s+/).filter(Boolean);
        const max = clampLimit(limit, 20, 50);
        const results: Array<{ score: number; route: ReturnType<typeof summarizeRoute> }> = [];

        for (const [namespace, data] of Object.entries(namespaces)) {
            const namespaceText = [namespace, data.name, data.url].filter(Boolean).join(' ').toLowerCase();
            const routes = Object.entries(data.routes || {});
            for (const [path, route] of routes) {
                const routeText = [path, route.name, ...(route.categories || [])].filter(Boolean).join(' ').toLowerCase();
                if (words.some((word) => !namespaceText.includes(word) && !routeText.includes(word))) {
                    continue;
                }
                // Prefer exact namespace matches, then matches in the namespace, then in the route itself
                const score = words.reduce((sum, word) => sum + (namespace === word ? 3 : 0) + (namespaceText.includes(word) ? 2 : 0) + (routeText.includes(word) ? 1 : 0), 0);
                results.push({ score, route: summarizeRoute(namespace, path, route) });
            }
        }

        results.sort((a, b) => b.score - a.score);
        return { total: results.length, routes: results.slice(0, max).map((result) => result.route) };
    },
};

const getNamespace: Tool = {
    name: 'get_namespace',
    title: 'Get namespace',
    description: 'Get a namespace (usually one website, e.g. "github") with all of its routes, parameters, examples and descriptions.',
    inputSchema: {
        type: 'object',
        properties: {
            namespace: { type: 'string', description: 'Namespace key, e.g. "github" or "bilibili"' },
        },
        required: ['namespace'],
    },
    annotations: { readOnlyHint: true, openWorldHint: false },
    handler: async (args) => {
        await ensureAllLoaded();
        const namespace = String(args.namespace ?? '').replaceAll(/^\/+|\/+$/g, '');
        const data = namespaces[namespace];
        if (!data) {
            throw new Error(`Namespace "${args.namespace}" not found. Use search_routes to find the right namespace.`);
        }
        return {
            namespace,
            name: data.name,
            url: data.url,
            description: data.description,
            routes: Object.entries(data.routes || {}).map(([path, route]) => ({
                ...summarizeRoute(namespace, path, route),
                description: route.description,
            })),
        };
    },
};

const fetchFeed: Tool = {
    name: 'fetch_feed',
    title: 'Fetch feed',
    description:
        'Run an RSSHub route and return its feed items as JSON. `path` is an RSSHub route path such as "/github/issue/DIYgod/RSSHub" (use search_routes or get_namespace to build it). Common query parameters like "?filter=" may be included in the path.',
    inputSchema: {
        type: 'object',
        properties: {
            path: { type: 'string', description: 'RSSHub route path starting with "/"' },
            limit: { type: 'integer', description: 'Maximum number of items to return (default 20, max 100)', minimum: 1, maximum: 100 },
        },
        required: ['path'],
    },
    annotations: { readOnlyHint: true, openWorldHint: true },
    handler: async ({ path, limit }, { app, origin, env }) => {
        if (typeof path !== 'string' || !path.startsWith('/') || path.startsWith('//')) {
            throw new Error('`path` must be an RSSHub route path starting with a single "/", e.g. "/github/issue/DIYgod/RSSHub".');
        }
        if (/^\/(?:mcp|api)(?:\/|\?|$)/.test(path)) {
            throw new Error('`path` must be a feed route, not an API or MCP endpoint.');
        }

        const url = new URL(path, origin);
        url.searchParams.set('format', 'json');
        url.searchParams.set('limit', String(clampLimit(limit, 20, 100)));
        if (config.accessKey) {
            url.searchParams.set('key', config.accessKey);
        }

        const response = await app.request(url.href, { headers: { accept: 'application/feed+json' } }, env);
        const body = await response.text();
        if (!response.ok) {
            throw new Error(`Route returned HTTP ${response.status}: ${truncate(stripHtml(body), 1000)}`);
        }

        const feed = JSON.parse(body);
        return {
            title: feed.title,
            link: feed.home_page_url,
            description: feed.description,
            items: (feed.items || []).map((item) => ({
                title: item.title,
                link: item.url,
                pubDate: item.date_published,
                author: item.authors?.map((author) => author.name).join(', ') || undefined,
                category: item.tags,
                content: truncate(item.content_text || stripHtml(item.content_html), MAX_CONTENT_LENGTH),
                attachments: item.attachments,
            })),
        };
    },
};

const sourceToRegExp = (source: string) => {
    const pattern = source
        .split('/')
        .map((segment) => {
            if (segment === '*') {
                return '/.*';
            }
            const match = segment.match(/^:(\w+)(\?)?$/);
            if (match) {
                return match[2] ? `(?:/(?<${match[1]}>[^/]+))?` : `/(?<${match[1]}>[^/]+)`;
            }
            return segment ? `/${segment.replaceAll(/[.*+?^${}()|[\]\\]/g, String.raw`\$&`)}` : '';
        })
        .join('');
    return new RegExp(`^${pattern}/?$`);
};

const fillTarget = (target: string, params: Record<string, string | undefined>) => {
    let filled = target.replaceAll(/\/:(\w+)\?/g, (_, name) => {
        const value = params[name];
        return value ? `/${encodeURIComponent(value)}` : '';
    });
    filled = filled.replaceAll(/:(\w+)/g, (match, name) => {
        const value = params[name];
        return value ? encodeURIComponent(value) : match;
    });
    return /:\w+/.test(filled) ? undefined : filled;
};

const radarLookup: Tool = {
    name: 'radar_lookup',
    title: 'Find feeds for a URL',
    description: 'Given a website URL, find the RSSHub routes that can turn it into a feed. Returns ready-to-use paths for fetch_feed when the URL matches a rule exactly.',
    inputSchema: {
        type: 'object',
        properties: {
            url: { type: 'string', description: 'Full website URL, e.g. "https://github.com/DIYgod/RSSHub/issues"' },
        },
        required: ['url'],
    },
    annotations: { readOnlyHint: true, openWorldHint: false },
    handler: async ({ url }) => {
        let target: URL;
        try {
            target = new URL(String(url));
        } catch {
            throw new Error(`"${url}" is not a valid URL.`);
        }
        const { domain, subdomain } = parse(target.hostname);
        const rules = domain ? (await getRadarRules())[domain] : undefined;
        if (!rules) {
            return { matches: [], message: `No RSSHub radar rules for ${target.hostname}. Try search_routes instead.` };
        }

        const subdomains = [subdomain || '.', ...(subdomain === 'www' ? ['.'] : []), ...(subdomain ? [] : ['www']), '*'];
        const candidates = subdomains.flatMap((key) => (Array.isArray(rules[key]) ? rules[key] : []));
        const pathname = target.pathname.replace(/\/+$/, '') || '/';

        const matches = candidates.flatMap((rule) => {
            const ruleTarget = typeof rule.target === 'string' ? rule.target : undefined;
            for (const source of rule.source) {
                const params = sourceToRegExp(source.split(/[?#]/, 1)[0]).exec(pathname)?.groups;
                const path = params && ruleTarget ? fillTarget(ruleTarget, params) : undefined;
                if (path) {
                    return [{ title: rule.title, path, docs: rule.docs }];
                }
            }
            return [];
        });

        return matches.length
            ? { matches }
            : {
                  matches: [],
                  message: 'No rule matched this exact URL. These rules exist for the site; fill in their parameters manually.',
                  rules: candidates.map((rule) => ({ title: rule.title, source: rule.source, target: rule.target, docs: rule.docs })),
              };
    },
};

export const tools: Tool[] = [searchRoutes, getNamespace, fetchFeed, radarLookup];

export const listTools = () => tools.map(({ name, title, description, inputSchema, annotations }) => ({ name, title, description, inputSchema, annotations }));

export const callTool = async (name: string, args: Record<string, any>, context: ToolContext): Promise<ToolResult | undefined> => {
    const tool = tools.find((item) => item.name === name);
    if (!tool) {
        return;
    }
    try {
        const result = await tool.handler(args || {}, context);
        return { content: [{ type: 'text', text: JSON.stringify(result) }] };
    } catch (error) {
        return { content: [{ type: 'text', text: error instanceof Error ? error.message : String(error) }], isError: true };
    }
};
