// Invitations: owner and admins create a one-time link with a role; the invitee opens it, chooses a
// name and gets a personal token (shown once) and a page session cookie.
//
//   POST   /api/invites/check   { token }        public, rate limited: role, expiry, who invited
//   POST   /api/invites/accept  { token, name }  public, rate limited: creates the member
//   GET    /api/invites                          owner, admin: the last 100 with their status
//   POST   /api/invites         { role, days, note }  owner, admin: the link secret, once
//   DELETE /api/invites/:id                      owner, admin: revoke a pending one
//
// The secret travels in the URL fragment (`/#invite=…`), which browsers never send to a server, and
// in POST bodies, never in a query string: it stays out of access logs and Referer headers.
import { Limiter, clientKey } from './server.mjs';
import { SESSION_TTL_MS, can } from '../lib/accounts.mjs';

export function inviteRoutes({ limiter = new Limiter({ max: 10, windowMs: 15 * 60 * 1000 }) } = {}) {
  return {
    /** Before authentication. */
    async public(req, res, url, { accounts, send, jsonBody, sessionCookie, trustProxy }) {
      const path = url.pathname;
      if (path !== '/api/invites/check' && path !== '/api/invites/accept') return false;
      if (req.method !== 'POST') return send(res, 405, { error: 'method not allowed' }), true;
      // Every attempt counts, good or bad: a link is opened once or twice, never forty times.
      if (limiter.hit(clientKey(req, trustProxy))) return send(res, 429, { error: 'too many attempts, wait a few minutes' }), true;
      const site = req.headers['sec-fetch-site'];
      if (site && site !== 'same-origin' && site !== 'none') return send(res, 403, { error: 'cross-site request refused' }), true;
      const body = await jsonBody(req);
      if (path === '/api/invites/check') return send(res, 200, accounts.previewInvite(body.token)), true;
      const out = accounts.acceptInvite(body.token, body.name);
      res.setHeader('set-cookie', sessionCookie(out.session.token, Math.floor(SESSION_TTL_MS / 1000)));
      return send(res, 201, { member: out.member, token: out.api.token, csrf: out.session.csrf, note: 'your personal token, shown once: keep it for the plugin or the CLI' }), true;
    },

    /** After authentication. */
    async private(req, res, url, { accounts, auth, send, jsonBody, forbidden }) {
      const path = url.pathname;
      const m = req.method;
      if (path !== '/api/invites' && !path.startsWith('/api/invites/')) return false;
      if (!can(auth, 'manageMembers')) return forbidden(res, 'manage invitations', auth), true;
      const by = auth.member || 'user';
      if (path === '/api/invites' && m === 'GET') return send(res, 200, { invites: accounts.listInvites() }), true;
      if (path === '/api/invites' && m === 'POST') {
        const body = await jsonBody(req);
        const inv = accounts.createInvite({ role: body.role ?? 'member', days: body.days ?? undefined, note: body.note }, by);
        return send(res, 201, { ...inv, path: `#invite=${inv.token}`, note: 'the link is shown once' }), true;
      }
      const im = path.match(/^\/api\/invites\/(inv_[a-f0-9]{1,32})$/);
      if (im && m === 'DELETE') return send(res, accounts.revokeInvite(im[1], by) ? 200 : 404, { ok: true }), true;
      return send(res, 404, { error: 'not found' }), true;
    },
  };
}
