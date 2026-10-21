/**
 * 本地模型代理：把客户端请求转发到内网 Anthropic 兼容网关。
 *
 * 为什么要代理：
 * 1. 真实 Key 只留在本机进程环境里，不打进 Expo 客户端包；
 * 2. 浏览器直连内网网关通常会被 CORS / 证书拦住，代理统一加 CORS；
 * 3. 网关用 x-api-key 还是 Authorization 可以一键切换，不用改客户端。
 *
 * 启动：
 *   ANTHROPIC_BASE_URL=https://llmapi.bilibili.co \
 *   ANTHROPIC_API_KEY=xxx \
 *   BOT_MODEL=deepseek-v4-flash \
 *   npm run llm-proxy
 */
import fs from 'node:fs';
import http from 'node:http';

// .env.proxy 优先于 shell 环境，避免机器上已有的 ANTHROPIC_API_KEY 把空占位符盖掉
const ENV_FILE = process.env.PROXY_ENV_FILE || '.env.proxy';

function loadProxyEnv(file) {
  if (!fs.existsSync(file)) return;
  const lines = fs.readFileSync(file, 'utf8').split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq <= 0) continue;
    const key = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    process.env[key] = value;
  }
}

loadProxyEnv(ENV_FILE);

const PORT = Number(process.env.PORT || 8099);
const HOST = process.env.HOST || '127.0.0.1';
const BASE_URL = (process.env.ANTHROPIC_BASE_URL || 'https://llmapi.bilibili.co').replace(
  /\/+$/,
  ''
);
const API_KEY = process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN || '';
const AUTH_STYLE = (process.env.ANTHROPIC_AUTH_STYLE || 'x-api-key').toLowerCase();
const MODEL = process.env.ANTHROPIC_MODEL || process.env.BOT_MODEL || 'deepseek-v4-flash';
const MAX_TOKENS = Number(process.env.LLM_MAX_TOKENS || 1024);
// 可选：客户端必须带这个 token 才能用代理；默认只监听 127.0.0.1，不设也行
const PROXY_TOKEN = process.env.PROXY_TOKEN || '';

if (!API_KEY) {
  console.error(
    JSON.stringify({
      event: 'error',
      message: `missing ANTHROPIC_API_KEY：请在 ${ENV_FILE} 里把 key 补完整，或在 shell 里导出后再启动`,
    })
  );
  process.exit(1);
}

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers':
    'content-type, accept, x-api-key, authorization, anthropic-version, anthropic-dangerous-direct-browser-access',
  'Access-Control-Allow-Methods': 'POST, GET, OPTIONS',
  'Access-Control-Max-Age': '86400',
};

function authHeaders() {
  const headers = {
    'content-type': 'application/json',
    accept: 'text/event-stream',
    'anthropic-version': '2023-06-01',
  };
  if (AUTH_STYLE === 'bearer') headers.authorization = `Bearer ${API_KEY}`;
  else if (AUTH_STYLE === 'api-key') headers['api-key'] = API_KEY;
  else headers['x-api-key'] = API_KEY;
  return headers;
}

function sendJson(res, status, payload) {
  res.writeHead(status, { ...CORS, 'content-type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(payload));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', (chunk) => {
      body += chunk;
      if (body.length > 2_000_000) {
        reject(new Error('body_too_large'));
        req.destroy();
      }
    });
    req.on('end', () => resolve(body));
    req.on('error', reject);
  });
}

const server = http.createServer(async (req, res) => {
  if (req.method === 'OPTIONS') {
    res.writeHead(204, CORS);
    res.end();
    return;
  }

  if (req.method === 'GET' && req.url === '/health') {
    sendJson(res, 200, {
      ok: true,
      upstream: BASE_URL,
      authStyle: AUTH_STYLE,
      model: MODEL,
    });
    return;
  }

  if (req.method !== 'POST' || !req.url?.startsWith('/v1/messages')) {
    sendJson(res, 404, { error: 'not_found' });
    return;
  }

  if (PROXY_TOKEN && req.headers['x-api-key'] !== PROXY_TOKEN) {
    sendJson(res, 401, { error: 'proxy_token_invalid' });
    return;
  }

  let payload;
  try {
    payload = JSON.parse(await readBody(req));
  } catch (error) {
    sendJson(res, 400, { error: 'invalid_json', message: String(error) });
    return;
  }

  const body = {
    ...payload,
    model: payload.model || MODEL,
    max_tokens: payload.max_tokens || MAX_TOKENS,
    stream: true,
  };

  const controller = new AbortController();
  req.on('close', () => controller.abort());

  const startedAt = Date.now();
  try {
    const upstream = await fetch(`${BASE_URL}/v1/messages`, {
      method: 'POST',
      headers: authHeaders(),
      body: JSON.stringify(body),
      signal: controller.signal,
    });

    console.log(
      JSON.stringify({
        event: 'upstream',
        status: upstream.status,
        model: body.model,
        messages: Array.isArray(body.messages) ? body.messages.length : 0,
        ms: Date.now() - startedAt,
      })
    );

    if (!upstream.ok) {
      const detail = await upstream.text().catch(() => '');
      sendJson(res, upstream.status, {
        error: 'upstream_error',
        status: upstream.status,
        detail: detail.slice(0, 2000),
      });
      return;
    }

    res.writeHead(200, {
      ...CORS,
      'content-type': upstream.headers.get('content-type') || 'text/event-stream',
      'cache-control': 'no-cache',
      connection: 'keep-alive',
    });

    if (!upstream.body) {
      res.end();
      return;
    }
    for await (const chunk of upstream.body) {
      if (res.writableEnded) break;
      res.write(chunk);
    }
    res.end();
  } catch (error) {
    if (controller.signal.aborted) {
      res.end();
      return;
    }
    console.error(JSON.stringify({ event: 'proxy_error', message: String(error) }));
    if (!res.headersSent) {
      sendJson(res, 502, { error: 'proxy_error', message: String(error) });
    } else {
      res.end();
    }
  }
});

server.listen(PORT, HOST, () => {
  console.log(
    JSON.stringify({
      event: 'listening',
      url: `http://${HOST}:${PORT}`,
      upstream: BASE_URL,
      authStyle: AUTH_STYLE,
      model: MODEL,
    })
  );
});
