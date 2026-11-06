// Vercel serverless function: /api/nasa?u=<https url>
// Fallback used by the website when a browser is blocked from calling a NASA service directly (CORS).
// Only NASA hosts on the allow-list below can be reached, so this cannot be used as an open proxy.
const ALLOW = new Set(['modis.ornl.gov', 'eonet.gsfc.nasa.gov', 'power.larc.nasa.gov']);

module.exports = async (req, res) => {
  try {
    const u = new URL(String(req.query.u || ''));
    if (u.protocol !== 'https:' || !ALLOW.has(u.hostname)) { res.status(400).json({ error: 'host not allowed' }); return; }
    const r = await fetch(u.toString(), { headers: { Accept: 'application/json' } });
    const body = await r.text();
    res.setHeader('Content-Type', r.headers.get('content-type') || 'application/json');
    res.setHeader('Cache-Control', 's-maxage=3600, stale-while-revalidate=86400');
    res.status(r.status).send(body);
  } catch (e) {
    res.status(502).json({ error: String(e && e.message ? e.message : e) });
  }
};
