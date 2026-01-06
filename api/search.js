// api/search.js
export default async function handler(req, res) {
  // CORS
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");

  if (req.method === "OPTIONS") {
    return res.status(204).end();
  }

  if (req.method !== "GET") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  try {
    const { keywords, hours, lang = "tr", max = "10" } = req.query;

    if (!keywords) {
      return res.status(400).json({ error: "keywords required" });
    }

    const hoursNum = Number(hours);
    if (![1, 3, 6, 12, 24].includes(hoursNum)) {
      return res.status(400).json({ error: "hours must be one of 1,3,6,12,24" });
    }

    const maxNumRaw = Number(max);
    const maxNum = Number.isFinite(maxNumRaw) ? Math.min(Math.max(maxNumRaw, 1), 50) : 10;

    // Authorization header (Bearer token) UI'dan gelir
    const auth = req.headers.authorization || "";
    if (!auth.toLowerCase().startsWith("bearer ")) {
      return res.status(401).json({ error: "Missing Authorization header: Bearer <token>" });
    }

    // keywords format: "a,b,c"
    const list = String(keywords)
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean)
      .slice(0, 60);

    if (list.length === 0) {
      return res.status(400).json({ error: "No valid keywords" });
    }

    // Query oluştur
    // Retweetleri ele, dil filtresi ekle
    const orQuery = list
      .map((k) => `("${k.replaceAll('"', '\\"')}")`)
      .join(" OR ");

    const safeLang = String(lang).toLowerCase() === "en" ? "en" : "tr";
    const query = `(${orQuery}) -is:retweet lang:${safeLang}`;

    // Zaman aralığı
    const end = new Date();
    const start = new Date(end.getTime() - hoursNum * 60 * 60 * 1000);

    const params = new URLSearchParams({
      query,
      max_results: "5",
      start_time: start.toISOString(),
      end_time: end.toISOString(),
      "tweet.fields": "created_at,public_metrics,lang,author_id",
      expansions: "author_id",
      "user.fields": "username,name",
    });

    const url = `https://api.x.com/2/tweets/search/recent?${params.toString()}`;

    const r = await fetch(url, {
      method: "GET",
      headers: { Authorization: auth },
    });

    const data = await r.json().catch(() => null);

    if (!r.ok) {
      return res.status(r.status).json({
        error: "X API error",
        details: data || { message: "Unknown error" },
      });
    }

    const usersById = new Map();
    (data?.includes?.users || []).forEach((u) => usersById.set(u.id, u));

    const results = (data?.data || []).map((t) => {
      const pm = t.public_metrics || {};
      const like = pm.like_count || 0;
      const repost = pm.retweet_count || 0;
      const reply = pm.reply_count || 0;
      const quote = pm.quote_count || 0;

      const score = like + repost * 2 + reply * 1.5 + quote * 2;

      const u = usersById.get(t.author_id);
      const username = u?.username || "";
      const name = u?.name || "";

      const link = username
        ? `https://x.com/${username}/status/${t.id}`
        : `https://x.com/i/web/status/${t.id}`;

      return {
        id: t.id,
        text: t.text,
        created_at: t.created_at,
        lang: t.lang,
        author: { id: t.author_id, username, name },
        metrics: { like, repost, reply, quote },
        score,
        link,
      };
    });

    results.sort((a, b) => b.score - a.score);

    return res.status(200).json({
      keywords: list,
      query,
      window: { start: start.toISOString(), end: end.toISOString() },
      total_fetched: results.length,
      results: results.slice(0, maxNum),
    });
  } catch (e) {
    return res.status(500).json({ error: "Server error", details: String(e) });
  }
}
