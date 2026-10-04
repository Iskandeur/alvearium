// Compatibility file, not used by session-board itself: the HTTP client lives in lib/runtime.mjs.
// 0.3.4 shipped it here, and its cloud-refresh.sh fetches this path; a copy refreshed by that script
// must still find it, or its next update would fail. Keep it.
export { boardFetch, bypassProxy, explainReply, proxyFor, routeOf, trustedCAs } from './runtime.mjs';
