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

  // Upstash REST env
  const UPSTASH_URL = process.env.UPSTASH_REDIS_REST_URL || "";
  const UPSTASH_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN || "";
  const CACHE_TTL_SECONDS = 10 * 60; // 10 dakika

  // Tiny helpers (no external deps)
  const b64 = (s) => Buffer.from(String(s), "utf8").toString("base64");
  const cacheKeyOf = ({ keywordsCsv, hoursNum, safeLang }) => {
    // tokenı key'e dahil etmiyoruz (gizlilik + aynı sorguyu paylaşabilsin)
    // keywords sırasını normalize edelim ki aynı seçim farklı sırayla aynı cache'i kullansın
    const norm = String(keywordsCsv)
      .split(",")
      .map((x) => x.trim())
      .filter(Boolean)
      .map((x) => x.toLowerCase())
      .sort()
      .join(",");
    return `xAnalytics:v1:${hoursNum}:${safeLang}:${b64(norm)}`;
  };

  async function redisGet(key) {
    if (!UPSTASH_URL || !UPSTASH_TOKEN) return null;
    const r = await fetch(`${UPSTASH_URL}/get/${encodeURIComponent(key)}`, {
      headers: { Authorization: `Bearer ${UPSTASH_TOKEN}` },
    });
    if (!r.ok) return null;
    const j = await r.json().catch(() => null);
    // Upstash REST format: { result: "..." } or { result: null }
    if (!j || j.result == null) return null;
    try {
      return typeof j.result === "string" ? JSON.parse(j.result) : j.result;
    } catch {
      return null;
    }
  }

  async function redisSet(key, value, ttlSeconds) {
    if (!UPSTASH_URL || !UPSTASH_TOKEN) return false;
    const payload = encodeURIComponent(JSON.stringify(value));
    const r = await fetch(
      `${UPSTASH_URL}/set/${encodeURIComponent(key)}/${payload}?EX=${ttlSeconds}`,
      { headers: { Authorization: `Bearer ${UPSTASH_TOKEN}` } }
    );
    return r.ok;
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

    const safeLang = String(lang).toLowerCase() === "en" ? "en" : "tr";

    // 1) CACHE LOOKUP
    const cacheKey = cacheKeyOf({
      keywordsCsv: list.join(","),
      hoursNum,
      safeLang,
    });

    const cached = await redisGet(cacheKey);
    if (cached && cached.results && Array.isArray(cached.results)) {
      return res.status(200).json({
        ...cached,
        cache: { hit: true, ttl_seconds: CACHE_TTL_SECONDS },
      });
    }

    // Query oluştur
    // Retweetleri ele, dil filtresi ekle
    const orQuery = list
      .map((k) => `("${String(k).replaceAll('"', '\\"')}")`)
      .join(" OR ");

    const query = `(${orQuery}) -is:retweet lang:${safeLang}`;

    // Zaman aralığı
    const end = new Date();
    const start = new Date(end.getTime() - hoursNum * 60 * 60 * 1000);

    // X kuralı: max_results 10-100 arası olmalı. En düşük 10 kullanıyoruz.
    const params = new URLSearchParams({
      query,
      max_results: "10",
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
      // 2) Eğer 429 aldıysak ve cache varsa zaten yukarıda döndük.
      // Burada cache yoksa hata dönüyoruz.
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

    const responsePayload = {
      keywords: list,
      query,
      window: { start: start.toISOString(), end: end.toISOString() },
      total_fetched: results.length,
      results: results.slice(0, maxNum),
      cache: { hit: false, ttl_seconds: CACHE_TTL_SECONDS },
    };

    // 3) CACHE STORE
    // Cache'e maxNum uygulanmış hali yazıyoruz (UI için daha hızlı)
    await redisSet(cacheKey, responsePayload, CACHE_TTL_SECONDS);

    return res.status(200).json(responsePayload);
  } catch (e) {
    return res.status(500).json({ error: "Server error", details: String(e) });
  }
}
