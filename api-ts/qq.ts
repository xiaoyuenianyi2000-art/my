import handleRequest from '@yakult-green-tea/qq-music-api/serverless';
import { sealToken, SEALED_AUTH_PURPOSE } from '@yakult-green-tea/qq-music-api/dist/src/serverless/sealedSession.js';

// api-ts/qq.ts

/**
 * Vercel 上的 QQ 音乐 API 入口。
 *
 * frameworkless 项目里嵌套 catch-all（`api/qq/[...path].ts`）会被当成字面路由，三条嵌套路径全部
 * `NOT_FOUND`，所以这里是**扁平**入口：`vercel.json` 先把 `/api/qq/login/status`
 * rewrite 成 `/api/qq?path=/login/status`，再由本文件还原成后端认识的 `/login/status`。
 * 注入值写成 `/:path*` 而不是 `:path*`：裸的重复段在新版 path-to-regexp 里非法，`vercel dev`
 * 每次校验 `vercel.json` 都会刷一行 `[vc] PATH TO REGEXP ERROR`；带前缀后两版解析器都认。
 * Folia 侧因此两个平台都只填 `VITE_QQ_API_BASE=/api/qq`，不需要理解平台差异。
 *
 * 跑 Edge Runtime：3.0.0 的 `./serverless` 闭包已经是零 npm 包、零 `node:*`，Edge 能收；
 * 反过来这条约束也是守门人 —— 闭包哪天再混进 `node:*`，部署阶段就会直接被拒，
 * 而不是等到运行时才发现（Cloudflare 有 `nodejs_compat` 可以掩盖，Edge 没有）。
 */

export const config = { runtime: 'edge' };

const json = (body: unknown, status = 200, headers: Record<string, string> = {}): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      // Capacitor WebView（capacitor://localhost / https://localhost）会跨域请求这个接口，
      // 不带这条 CORS 头浏览器就会拦掉响应（Failed to fetch）。`*` 对默认（不带 credentials）的 fetch 合法。
      'access-control-allow-origin': '*',
      ...headers,
    },
  });

const parseCookieJar = (cookie: string): Record<string, string> => {
  const jar: Record<string, string> = {};
  for (const entry of cookie.split(';')) {
    const separator = entry.indexOf('=');
    if (separator <= 0) {
      // QQ 音乐 web 的登录 Cookie 有时把 uin（QQ 号）写成无键名的裸数字（`;1791989470;`），
      // 单独记下来当作候选 uin；只要纯数字位数够，就不参与其他字段的干扰。
      const bare = entry.trim();
      if (/^\d{5,}$/.test(bare) && !('__bare_uin' in jar)) jar['__bare_uin'] = bare;
      continue;
    }
    const name = entry.slice(0, separator).trim();
    const value = entry.slice(separator + 1).trim();
    if (name) jar[name] = value;
  }
  return jar;
};

const COOKIE_LOGIN_TTL_MS = 24 * 60 * 60 * 1000;

export default async function handler(request: Request): Promise<Response> {
  const url = new URL(request.url);

  // rewrite 注入的 `path` 是后端路径，其余 query 是调用方原本就带的，要原样透传。
  const params = new URLSearchParams(url.search);
  const path = params.get('path') ?? '';
  params.delete('path');

  const normalized = path.startsWith('/') ? path : `/${path}`;

  // ── Cookie 登录 ───────────────────────────────────────────────────────────
  // 手机端没法像桌面那样内嵌后端扫 QQ 码，改由用户把在 music.qq.com / y.qq.com 登录后复制来的
  // Cookie（含 uin 与 musickey）交给后端，后端把它封成与扫码同样的 sealed 会话令牌返回。
  // 请求 QQ 音乐实际只需要 uin(=musicid) + musickey，而 y.qq.com 登录态里正好有这两个字段。
  if (normalized === '/login/cookie') {
    const secret = process.env.QQ_SESSION_SECRET;
    if (!secret) return json({ code: 501, message: 'QQ_SESSION_SECRET is not set on the server' }, 501);

    const cookie = params.get('cookie') ?? '';
    if (!cookie) return json({ code: 400, message: 'cookie is required (cookie=... copied from music.qq.com)' }, 400);

    const jar = parseCookieJar(cookie);
    const uin = jar['uin'] ?? jar['qqmusic_uin'] ?? jar['__uin'] ?? jar['__bare_uin'];
    const musickey = jar['musickey'] ?? jar['qm_keyst'] ?? jar['qqmusic_key'];
    if (!uin || !musickey) {
      return json(
        {
          code: 400,
          message: 'cookie must contain uin=... and musickey=... — log in at music.qq.com, then copy the Cookie header',
        },
        400,
      );
    }

    const credential = {
      musicid: Number(uin) || uin,
      str_musicid: String(uin),
      musickey,
      loginType: 6,
      ...(jar['encryptUin'] ? { encryptUin: jar['encryptUin'] } : {}),
    };
    const token = await sealToken(
      { v: 1, iat: Date.now(), exp: Date.now() + COOKIE_LOGIN_TTL_MS, cred: credential },
      SEALED_AUTH_PURPOSE,
      secret,
    );
    return json(
      { code: 200, data: { token } },
      200,
      { 'set-cookie': `qqmusic_session=${token}; HttpOnly; Max-Age=${COOKIE_LOGIN_TTL_MS / 1000}; SameSite=Lax; Path=/` },
    );
  }

  const search = params.toString();
  const target = new URL(`${normalized}${search ? `?${search}` : ''}`, url.origin);

  // 用原请求构造新请求，method / headers / body 全部保留：`X-QQ-Session` 靠这里带到后端。
  return handleRequest(new Request(target, request), {
    QQ_SESSION_SECRET: process.env.QQ_SESSION_SECRET,
    QQ_SESSION_SECRET_PREVIOUS: process.env.QQ_SESSION_SECRET_PREVIOUS,
  });
}
