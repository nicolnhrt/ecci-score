const YAHOO_BASE_URL = "https://query2.finance.yahoo.com";
const FRED_BASE_URL = "https://api.stlouisfed.org/fred";
const CBOE_DAILY_PRICES_BASE_URL = "https://cdn.cboe.com/api/global/us_indices/daily_prices";
const SHILLER_CAPE_URL = "http://www.econ.yale.edu/~shiller/data/ie_data.xls";
const ECO3MIN_HY_OAS_URL = "https://eco3min.fr/wp-content/uploads/2026/04/us-hy-credit-spread-vs-sp500-1997-present.csv";

const YAHOO_ALLOWED_PREFIXES = [
  "/v7/finance",
  "/v8/finance",
  "/v10/finance",
  "/ws/fundamentals-timeseries",
];

const CBOE_ALLOWED_SYMBOLS = new Set(["VIX", "VVIX", "VIX9D", "VIX3M", "VIX6M", "VIX1Y"]);

const DEFAULT_CACHE_SECONDS = {
  yahoo: 900,
  fred: 21_600,
  cboe: 21_600,
  shiller: 86_400,
  finra: 86_400,
};

export default {
  async fetch(request, env, ctx) {
    if (request.method === "OPTIONS") {
      return handleOptions(request, env);
    }

    const allowedToken = env.CF_TOKEN;

    if (!allowedToken) {
      return textResponse("Worker misconfigured: CF_TOKEN is missing", 500, env, request);
    }

    const token = request.headers.get("X-Auth-Token");
    if (token !== allowedToken) {
      return textResponse("Unauthorized", 401, env, request);
    }

    if (request.method !== "GET") {
      return textResponse("Method not allowed", 405, env, request);
    }

    const url = new URL(request.url);

    try {
      if (url.pathname === "/health") {
        return jsonResponse({ ok: true, service: "ecci-data-worker" }, 200, env, {}, request);
      }

      if (url.pathname.startsWith("/yahoo/")) {
        return withCache(request, env, ctx, "yahoo", () => proxyYahoo(url, env, request));
      }

      if (YAHOO_ALLOWED_PREFIXES.some((prefix) => url.pathname.startsWith(prefix))) {
        return withCache(request, env, ctx, "yahoo", () => proxyYahoo(url, env, request, true));
      }

      if (url.pathname.startsWith("/fred/series/")) {
        return withCache(request, env, ctx, "fred", () => proxyFredSeries(url, env, request));
      }

      if (url.pathname === "/fred/batch") {
        return withCache(request, env, ctx, "fred", () => proxyFredBatch(url, env, request));
      }

      if (url.pathname === "/cboe/vix") {
        return withCache(request, env, ctx, "cboe", () => proxyCboeVix(url, env, request));
      }

      if (url.pathname === "/shiller/cape") {
        return withCache(request, env, ctx, "shiller", () =>
          proxyFixedUrl(SHILLER_CAPE_URL, env, request, "application/vnd.ms-excel"),
        );
      }

      if (url.pathname === "/finra/margin") {
        return withCache(request, env, ctx, "finra", () => proxyFinraMargin(env, request));
      }

      if (url.pathname === "/eco3min/hy-oas") {
        return withCache(request, env, ctx, "eco3min", () =>
          proxyFixedUrl(ECO3MIN_HY_OAS_URL, env, request, "text/csv"),
        );
      }

      return jsonResponse(
        {
          error: "Unknown route",
          routes: [
            "/health",
            "/yahoo/v8/finance/chart/SPY?range=5y&interval=1d",
            "/fred/series/BAMLH0A0HYM2",
            "/fred/batch?series=DGS10,DGS2,FEDFUNDS,CPIAUCSL,DFII10,NFCI",
            "/cboe/vix?symbol=VIX",
            "/shiller/cape",
            "/finra/margin",
            "/eco3min/hy-oas",
          ],
        },
        404,
        env,
        {},
        request,
      );
    } catch (error) {
      return jsonResponse(
        {
          error: "Proxy error",
          message: error instanceof Error ? error.message : String(error),
        },
        502,
        env,
        {},
        request,
      );
    }
  },
};

async function proxyYahoo(url, env, request, keepOriginalPath = false) {
  const yahooPath = keepOriginalPath ? url.pathname : url.pathname.replace(/^\/yahoo/, "");

  if (!YAHOO_ALLOWED_PREFIXES.some((prefix) => yahooPath.startsWith(prefix))) {
    return jsonResponse({ error: "Yahoo path is not allowed" }, 400, env, {}, request);
  }

  const target = new URL(`${YAHOO_BASE_URL}${yahooPath}`);
  target.search = url.search;

  return fetchUpstream(target, env, request, {
    headers: yahooHeaders(),
    contentType: "application/json",
  });
}

async function proxyFredSeries(url, env, request) {
  if (!env.FRED_API_KEY) {
    return jsonResponse({ error: "Worker misconfigured: FRED_API_KEY is missing" }, 500, env, {}, request);
  }

  const seriesId = url.pathname.replace("/fred/series/", "").trim().toUpperCase();

  if (!/^[A-Z0-9_.-]+$/.test(seriesId)) {
    return jsonResponse({ error: "Invalid FRED series id" }, 400, env, {}, request);
  }

  const target = buildFredObservationsUrl(seriesId, url, env);
  return fetchUpstream(target, env, request, { contentType: "application/json" });
}

async function proxyFredBatch(url, env, request) {
  if (!env.FRED_API_KEY) {
    return jsonResponse({ error: "Worker misconfigured: FRED_API_KEY is missing" }, 500, env, {}, request);
  }

  const series = (url.searchParams.get("series") ?? "")
    .split(",")
    .map((seriesId) => seriesId.trim().toUpperCase())
    .filter(Boolean);

  if (series.length === 0 || series.length > 20) {
    return jsonResponse({ error: "Provide 1 to 20 FRED series ids in ?series=" }, 400, env, {}, request);
  }

  for (const seriesId of series) {
    if (!/^[A-Z0-9_.-]+$/.test(seriesId)) {
      return jsonResponse({ error: `Invalid FRED series id: ${seriesId}` }, 400, env, {}, request);
    }
  }

  const results = await Promise.all(
    series.map(async (seriesId) => {
      const target = buildFredObservationsUrl(seriesId, url, env);
      const response = await fetch(target);
      const payload = await response.json();
      return { seriesId, status: response.status, payload };
    }),
  );

  return jsonResponse({ results }, 200, env, {
    "Cache-Control": cacheControlHeader("fred", env),
  }, request);
}

function buildFredObservationsUrl(seriesId, sourceUrl, env) {
  const target = new URL(`${FRED_BASE_URL}/series/observations`);
  target.searchParams.set("series_id", seriesId);
  target.searchParams.set("api_key", env.FRED_API_KEY);
  target.searchParams.set("file_type", "json");
  target.searchParams.set("sort_order", sourceUrl.searchParams.get("sort_order") ?? "asc");

  copyOptionalParams(sourceUrl, target, [
    "observation_start",
    "observation_end",
    "frequency",
    "aggregation_method",
    "units",
    "limit",
    "offset",
    "realtime_start",
    "realtime_end",
    "vintage_dates",
  ]);

  return target;
}

async function proxyCboeVix(url, env, request) {
  const symbol = (url.searchParams.get("symbol") ?? "VIX").trim().toUpperCase();

  if (!CBOE_ALLOWED_SYMBOLS.has(symbol)) {
    return jsonResponse({ error: "CBOE symbol is not allowed" }, 400, env, {}, request);
  }

  return proxyFixedUrl(`${CBOE_DAILY_PRICES_BASE_URL}/${symbol}_History.csv`, env, request, "text/csv");
}

async function proxyFinraMargin(env, request) {
  if (!env.FINRA_MARGIN_URL) {
    return jsonResponse(
      {
        error: "Worker misconfigured: FINRA_MARGIN_URL is missing",
        hint: "Set FINRA_MARGIN_URL to the current FINRA margin statistics Excel file URL.",
      },
      500,
      env,
      {},
      request,
    );
  }

  return proxyFixedUrl(
    env.FINRA_MARGIN_URL,
    env,
    request,
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  );
}

async function proxyFixedUrl(targetUrl, env, request, contentType) {
  return fetchUpstream(new URL(targetUrl), env, request, {
    contentType,
    headers: {
      "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
      Accept: "*/*",
    },
  });
}

async function fetchUpstream(target, env, request, options = {}) {
  const response = await fetch(target, {
    headers: options.headers,
  });

  const headers = responseHeaders(env, {
    "Content-Type": options.contentType ?? response.headers.get("Content-Type") ?? "application/octet-stream",
  }, request);

  return new Response(response.body, {
    status: response.status,
    headers,
  });
}

async function withCache(request, env, ctx, cacheKeyName, handler) {
  const cache = caches.default;
  const cacheRequest = new Request(request.url, request);
  const cached = await cache.match(cacheRequest);

  if (cached) {
    const cachedHeaders = new Headers(cached.headers);
    cachedHeaders.set("X-ECCI-Cache", "HIT");
    return new Response(cached.body, {
      status: cached.status,
      headers: cachedHeaders,
    });
  }

  const response = await handler();
  const responseToCache = new Response(response.body, response);
  responseToCache.headers.set("Cache-Control", cacheControlHeader(cacheKeyName, env));
  responseToCache.headers.set("X-ECCI-Cache", "MISS");

  if (response.ok) {
    ctx.waitUntil(cache.put(cacheRequest, responseToCache.clone()));
  }

  return responseToCache;
}

function cacheControlHeader(cacheKeyName, env) {
  const envKey = `CACHE_SECONDS_${cacheKeyName.toUpperCase()}`;
  const seconds = Number(env[envKey] ?? DEFAULT_CACHE_SECONDS[cacheKeyName] ?? 900);
  return `public, max-age=${seconds}`;
}

function yahooHeaders() {
  return {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
    Accept: "application/json, text/plain, */*",
    "Accept-Language": "en-US,en;q=0.9",
    Referer: "https://finance.yahoo.com",
  };
}

function copyOptionalParams(sourceUrl, targetUrl, params) {
  for (const param of params) {
    const value = sourceUrl.searchParams.get(param);
    if (value) {
      targetUrl.searchParams.set(param, value);
    }
  }
}

function handleOptions(request, env) {
  return new Response(null, {
    status: 204,
    headers: corsHeaders(env, request),
  });
}

function jsonResponse(payload, status, env, extraHeaders = {}, request) {
  return new Response(JSON.stringify(payload, null, 2), {
    status,
    headers: responseHeaders(env, {
      "Content-Type": "application/json",
      ...extraHeaders,
    }, request),
  });
}

function textResponse(message, status, env, request) {
  return new Response(message, {
    status,
    headers: responseHeaders(env, {
      "Content-Type": "text/plain; charset=utf-8",
    }, request),
  });
}

function responseHeaders(env, extraHeaders = {}, request) {
  return {
    ...corsHeaders(env, request),
    "X-Content-Type-Options": "nosniff",
    ...extraHeaders,
  };
}

function corsHeaders(env, request) {
  const requestOrigin = request?.headers.get("Origin");
  const allowedOrigins = getAllowedOrigins(env);
  const allowOrigin =
    requestOrigin && allowedOrigins.includes(requestOrigin)
      ? requestOrigin
      : allowedOrigins[0];

  return {
    "Access-Control-Allow-Origin": allowOrigin,
    "Access-Control-Allow-Methods": "GET, OPTIONS",
    "Access-Control-Allow-Headers": "X-Auth-Token, Content-Type",
    "Access-Control-Max-Age": "86400",
    Vary: "Origin",
  };
}

function getAllowedOrigins(env) {
  if (env.ALLOWED_ORIGINS) {
    return env.ALLOWED_ORIGINS.split(",").map((origin) => origin.trim()).filter(Boolean);
  }

  if (env.ALLOWED_ORIGIN) {
    return uniqueOrigins([
      ...env.ALLOWED_ORIGIN.split(",").map((origin) => origin.trim()).filter(Boolean),
      "http://localhost:5173",
      "http://127.0.0.1:5173",
    ]);
  }

  return ["http://localhost:5173", "http://127.0.0.1:5173"];
}

function uniqueOrigins(origins) {
  return [...new Set(origins.filter(Boolean))];
}
