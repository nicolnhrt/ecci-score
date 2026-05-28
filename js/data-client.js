const DEFAULT_SNAPSHOT_URL = "./data/ecci-snapshot.json";
const DEFAULT_HISTORY_BASE_URL = "./data/ecci-history-base.json";
const DEFAULT_RECENT_URL = "./data/ecci-recent.json";

export async function loadSnapshot() {
  if (window.location.protocol === "file:") {
    throw new Error("static JSON cannot be loaded from file://. Serve the folder with a local web server or deploy it on GitHub Pages.");
  }

  const config = window.ECCI_CONFIG || {};
  const [snapshot, historyBase, recent] = await Promise.all([
    fetchJson(config.snapshotUrl || DEFAULT_SNAPSHOT_URL, true),
    fetchJson(config.historyBaseUrl || DEFAULT_HISTORY_BASE_URL, false, true),
    fetchJson(config.recentUrl || DEFAULT_RECENT_URL, true),
  ]);

  return {
    ...snapshot,
    history: mergeHistory(historyBase?.history ?? [], recent?.history ?? snapshot.history ?? []),
    historySources: {
      base: historyBase,
      recent,
    },
  };
}

async function fetchJson(endpoint, bustCache, optional = false) {
  const response = await fetch(bustCache ? withCacheBust(endpoint) : endpoint, {
    headers: { accept: "application/json" },
    cache: bustCache ? "no-store" : "force-cache",
  });

  if (!response.ok) {
    if (optional && response.status === 404) return null;
    throw new Error(`${endpoint} unavailable (${response.status})`);
  }

  return response.json();
}

function mergeHistory(baseHistory, recentHistory) {
  const pointsByDate = new Map();
  for (const point of baseHistory) pointsByDate.set(point.date, point);
  for (const point of recentHistory) pointsByDate.set(point.date, point);
  return [...pointsByDate.values()].sort((left, right) => left.date.localeCompare(right.date));
}

function withCacheBust(url) {
  const separator = url.includes("?") ? "&" : "?";
  return `${url}${separator}v=${new Date().toISOString().slice(0, 10)}`;
}
