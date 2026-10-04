// session-board — the one HTTP client of the plugin (hooks, MCP server, /board, /ticket, import).
//
// Why not the global fetch: Node's fetch ignores HTTPS_PROXY / https_proxy unless the process was
// started with NODE_USE_ENV_PROXY=1 (or --use-env-proxy), which only recent Node versions know. In a
// claude.ai/code cloud session every request is meant to leave through the agent proxy named in
// HTTPS_PROXY: that proxy attaches the environment's API credential (SESSION_BOARD_TOKEN=proxy). A
// request that bypasses it reaches the board without credential; behind an auth gateway (Cloudflare
// Access…) it is redirected to a login page, which fetch followed and read as a 200 — every hook
// "sent", every ticket "Created undefined", nothing on the board (0.3.3 and before).
//
// So: zero dependencies, node:http + node:tls, CONNECT tunnel through the proxy when the environment
// names one (NO_PROXY respected), and redirects are never followed (a redirect from the board API is
// a gateway, not the board). The returned object has the subset of the fetch Response the plugin uses.
import { readFileSync } from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import tls from 'node:tls';

const MAX_BODY = 8 * 1024 * 1024;

const envOf = (env, name) => env[name.toLowerCase()] || env[name.toUpperCase()] || '';

/** NO_PROXY: `*`, host names (suffix match, leading `.` or `*.` optional), optional `:port`. */
export function bypassProxy(target, noProxy) {
  const list = String(noProxy || '')
    .split(/[\s,]+/)
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
  if (!list.length) return false;
  const host = target.hostname.toLowerCase().replace(/^\[|\]$/g, '');
  const port = target.port || (target.protocol === 'https:' ? '443' : '80');
  for (const entry of list) {
    if (entry === '*') return true;
    let [h, p] = entry.startsWith('[') ? [entry.slice(1, entry.indexOf(']')), entry.split(']:')[1]] : entry.split(':');
    if (p && p !== port) continue;
    h = h.replace(/^\*?\./, '');
    if (host === h || host.endsWith('.' + h)) return true;
  }
  return false;
}

/** The proxy URL for a target, from the environment (lower case wins, like curl), or null. */
export function proxyFor(url, env = process.env) {
  const target = url instanceof URL ? url : new URL(url);
  const raw = target.protocol === 'https:' ? envOf(env, 'https_proxy') || envOf(env, 'all_proxy') : envOf(env, 'http_proxy') || envOf(env, 'all_proxy');
  if (!raw) return null;
  if (bypassProxy(target, envOf(env, 'no_proxy'))) return null;
  try {
    const p = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : `http://${raw}`);
    return p.protocol === 'http:' || p.protocol === 'https:' ? p : null;
  } catch {
    return null;
  }
}

/** How a request to `url` leaves this machine, for messages: `direct` or `proxy host:port`. */
export function routeOf(url, env = process.env) {
  const p = proxyFor(url, env);
  return p ? `proxy ${p.hostname}:${p.port || (p.protocol === 'https:' ? 443 : 80)}` : 'direct';
}

const readPem = (path) => {
  try {
    return path ? readFileSync(path, 'utf8') : '';
  } catch {
    return '';
  }
};

let caCache;
/**
 * Certificates to trust through a proxy. An intercepting proxy (the agent proxy adds a header to an
 * HTTPS request, so it terminates TLS) presents certificates signed by its own CA, installed in the
 * system store: curl trusts them, Node only trusts its bundled roots. Bundled + extra + system.
 */
export function trustedCAs(env = process.env) {
  if (caCache && caCache.env === env) return caCache.list;
  const list = [];
  try {
    list.push(...(tls.getCACertificates?.('default') ?? tls.rootCertificates));
  } catch {
    list.push(...tls.rootCertificates);
  }
  let system = [];
  try {
    system = tls.getCACertificates?.('system') ?? [];
  } catch {}
  list.push(...system);
  for (const name of ['NODE_EXTRA_CA_CERTS', 'SSL_CERT_FILE', 'CURL_CA_BUNDLE', 'REQUESTS_CA_BUNDLE']) {
    const pem = readPem(env[name]);
    if (pem) list.push(pem);
  }
  if (!system.length) for (const p of ['/etc/ssl/certs/ca-certificates.crt', '/etc/pki/tls/certs/ca-bundle.crt', '/etc/ssl/cert.pem']) {
    const pem = readPem(p);
    if (pem) {
      list.push(pem);
      break;
    }
  }
  caCache = { env, list };
  return list;
}

function basicAuth(u) {
  if (!u.username) return undefined;
  return 'Basic ' + Buffer.from(`${decodeURIComponent(u.username)}:${decodeURIComponent(u.password)}`).toString('base64');
}

class HeadersView {
  constructor(raw) {
    this.raw = raw;
  }
  get(name) {
    const v = this.raw[String(name).toLowerCase()];
    return v === undefined ? null : Array.isArray(v) ? v.join(', ') : String(v);
  }
}

function responseOf(res, buf, url, route) {
  return {
    status: res.statusCode,
    statusText: res.statusMessage || '',
    ok: res.statusCode >= 200 && res.statusCode < 300,
    redirected: false,
    url,
    route,
    headers: new HeadersView(res.headers),
    text: async () => buf.toString('utf8'),
    json: async () => JSON.parse(buf.toString('utf8')),
    arrayBuffer: async () => buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength),
  };
}

const abortError = (signal) => {
  const r = signal?.reason;
  if (r instanceof Error) return r;
  return Object.assign(new Error('The operation was aborted'), { name: 'AbortError' });
};

/** Open a socket to target through an HTTP(S) proxy (CONNECT), TLS on top for an https target. */
function tunnel(target, proxy, env, onRequest) {
  return new Promise((resolve, reject) => {
    const port = target.port || (target.protocol === 'https:' ? 443 : 80);
    const authority = `${target.hostname.includes(':') && !target.hostname.startsWith('[') ? `[${target.hostname}]` : target.hostname}:${port}`;
    const mod = proxy.protocol === 'https:' ? https : http;
    const req = mod.request({
      host: proxy.hostname.replace(/^\[|\]$/g, ''),
      port: proxy.port || (proxy.protocol === 'https:' ? 443 : 80),
      method: 'CONNECT',
      path: authority,
      headers: { host: authority, ...(basicAuth(proxy) ? { 'proxy-authorization': basicAuth(proxy) } : {}) },
      agent: false,
      ...(proxy.protocol === 'https:' ? { ca: trustedCAs(env) } : {}),
    });
    onRequest(req);
    req.once('connect', (res, socket, head) => {
      if (res.statusCode !== 200) {
        socket.destroy();
        reject(Object.assign(new Error(`the proxy ${proxy.hostname}:${proxy.port} refused the tunnel to ${authority}: ${res.statusCode} ${res.statusMessage || ''}`.trim()), { code: 'PROXY_CONNECT', status: res.statusCode }));
        return;
      }
      if (head?.length) socket.unshift(head);
      if (target.protocol !== 'https:') return resolve(socket);
      const secure = tls.connect({ socket, servername: target.hostname.replace(/^\[|\]$/g, ''), ca: trustedCAs(env), ALPNProtocols: ['http/1.1'] });
      secure.once('secureConnect', () => resolve(secure));
      secure.once('error', reject);
    });
    req.once('error', (e) => reject(Object.assign(new Error(`proxy ${proxy.hostname}:${proxy.port}: ${e?.message || e?.code || e}`, { cause: e }), { code: e?.code })));
    req.end();
  });
}

/**
 * fetch-like request: `init` = { method, headers, body (string|Buffer), signal }. Never follows a
 * redirect (the response says 3xx and carries `location`). `env` picks the proxy (tests).
 */
export async function boardFetch(url, init = {}, { env = process.env } = {}) {
  const target = new URL(url);
  if (target.protocol !== 'https:' && target.protocol !== 'http:') throw new Error(`unsupported URL ${target.protocol}`);
  const signal = init.signal;
  if (signal?.aborted) throw abortError(signal);
  const proxy = proxyFor(target, env);
  const route = proxy ? `proxy ${proxy.hostname}:${proxy.port || (proxy.protocol === 'https:' ? 443 : 80)}` : 'direct';
  const body = init.body == null ? null : Buffer.isBuffer(init.body) ? init.body : Buffer.from(String(init.body));
  const headers = {};
  for (const [k, v] of Object.entries(init.headers || {})) if (v !== undefined) headers[k.toLowerCase()] = String(v);
  if (body && headers['content-length'] === undefined) headers['content-length'] = String(body.length);
  headers['accept-encoding'] = 'identity';

  let current; // the in-flight ClientRequest (CONNECT first, then the request itself)
  const onAbort = () => current?.destroy(abortError(signal));
  signal?.addEventListener('abort', onAbort, { once: true });
  try {
    let options;
    const path = target.pathname + target.search;
    if (!proxy) {
      options = { mod: target.protocol === 'https:' ? https : http, host: target.hostname.replace(/^\[|\]$/g, ''), port: target.port || undefined, path };
    } else if (target.protocol === 'http:') {
      // plain http through a proxy: absolute URI to the proxy, no tunnel
      const pa = basicAuth(proxy);
      if (pa) headers['proxy-authorization'] = pa;
      options = { mod: proxy.protocol === 'https:' ? https : http, host: proxy.hostname.replace(/^\[|\]$/g, ''), port: proxy.port || undefined, path: target.href, hostHeader: target.host };
    } else {
      const socket = await tunnel(target, proxy, env, (r) => (current = r));
      if (signal?.aborted) {
        socket.destroy();
        throw abortError(signal);
      }
      options = { mod: http, host: target.hostname.replace(/^\[|\]$/g, ''), port: target.port || 443, path, createConnection: () => socket };
    }
    return await new Promise((resolve, reject) => {
      const req = options.mod.request({
        host: options.host,
        port: options.port,
        path: options.path,
        method: init.method || 'GET',
        headers: { host: options.hostHeader || target.host, ...headers },
        ...(options.createConnection ? { createConnection: options.createConnection } : { agent: false }),
      });
      current = req;
      req.once('response', (res) => {
        const chunks = [];
        let size = 0;
        res.on('data', (c) => {
          size += c.length;
          if (size <= MAX_BODY) chunks.push(c);
        });
        res.once('end', () => {
          resolve(responseOf(res, Buffer.concat(chunks), target.href, route));
          req.socket?.destroy?.();
        });
        res.once('error', reject);
      });
      req.once('error', reject);
      req.end(body || undefined);
    });
  } finally {
    signal?.removeEventListener('abort', onAbort);
  }
}

/**
 * One line saying why a reply from the board API is not the board: a redirect (an auth gateway in
 * front of the server), 401/403, or a 2xx that is not JSON (a login page). '' when it looks fine.
 */
export function explainReply(res, text, { url = '', token = '', env = process.env } = {}) {
  const host = (() => {
    try {
      return new URL(url).host;
    } catch {
      return 'the board host';
    }
  })();
  const cloud = env.CLAUDE_CODE_REMOTE === 'true';
  const route = routeOf(url || 'https://x.invalid', env);
  const credentialHint =
    token === 'proxy'
      ? cloud
        ? route === 'direct'
          ? `the request went out directly, not through the agent proxy (no HTTPS_PROXY in this process), so no API credential was attached for ${host}`
          : `the request went through the agent proxy (${route}) but came back without the credential: check that the environment's API credential lists the host ${host} exactly`
        : `SESSION_BOARD_TOKEN=proxy only works where a proxy adds the credential (claude.ai/code API credential for ${host}); here set the real token`
      : token
        ? 'the token was refused, or a gateway in front of the server wants its own credential'
        : 'no token is configured';
  const status = res.status;
  if (status >= 300 && status < 400) {
    const loc = res.headers?.get?.('location') || '';
    return `HTTP ${status} redirect to ${loc.slice(0, 120) || '(no location)'}: a gateway in front of the board (a login page${/cloudflareaccess|\/cdn-cgi\/access/.test(loc) ? ', Cloudflare Access' : ''}) stopped the request; ${credentialHint}.`;
  }
  if (status === 401 || status === 403) return `HTTP ${status} from ${host}: ${credentialHint}. ${String(text || '').replace(/\s+/g, ' ').slice(0, 120)}`.trim();
  if (status >= 200 && status < 300) {
    const t = String(text || '').trim();
    if (!t.startsWith('{') && !t.startsWith('[')) {
      const ct = res.headers?.get?.('content-type') || 'unknown type';
      return `HTTP ${status} from ${host} but not the board API (${ct}: ${t.replace(/\s+/g, ' ').slice(0, 80)}): a login or proxy page? ${credentialHint}.`;
    }
  }
  return '';
}
