/***** Cloudflare Worker: serves the app and forwards /api to Apps Script *****/
export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === '/api') {
      if (request.method !== 'POST') {
        return new Response(JSON.stringify({ ok: false, error: 'Use POST' }), {
          status: 405, headers: { 'Content-Type': 'application/json' }
        });
      }
      try {
        const body = await request.text();
        const res = await fetch(env.APPS_SCRIPT_URL, {
          method: 'POST',
          headers: { 'Content-Type': 'text/plain;charset=utf-8' },
          body: body,
          redirect: 'follow'
        });
        const text = await res.text();
        return new Response(text, {
          status: 200,
          headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }
        });
      } catch (err) {
        return new Response(JSON.stringify({ ok: false, error: 'Proxy error: ' + err.message }), {
          status: 502, headers: { 'Content-Type': 'application/json' }
        });
      }
    }

    return env.ASSETS.fetch(request);
  }
};
