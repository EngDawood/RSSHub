import type { Context, MiddlewareHandler } from 'hono';

import { config } from '@/config';
import RejectError from '@/errors/types/reject';
import md5 from '@/utils/md5';

const reject = (requestPath) => {
    throw new RejectError(`Authentication failed. Access denied.\n${requestPath}`);
};

// Accept the key from `?key=`, `Authorization: Bearer <key>`, `api-key` or `x-api-key`
const getAccessKey = (ctx: Context) => ctx.req.query('key') || ctx.req.header('authorization')?.replace(/^Bearer\s+/i, '') || ctx.req.header('api-key') || ctx.req.header('x-api-key');

const middleware: MiddlewareHandler = async (ctx, next) => {
    const requestPath = new URL(ctx.req.url).pathname;
    const accessKey = getAccessKey(ctx);
    const accessCode = ctx.req.query('code');

    if (['/', '/robots.txt', '/favicon.ico', '/logo.png'].includes(requestPath)) {
        await next();
    } else {
        if (config.accessKey && !(config.accessKey === accessKey || accessCode === md5(requestPath + config.accessKey))) {
            return reject(requestPath);
        }
        await next();
    }
};

export default middleware;
