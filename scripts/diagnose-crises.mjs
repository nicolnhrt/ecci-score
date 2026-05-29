const PROXY_URL = process.env.ECCI_PROXY_URL;
const TOKEN = process.env.ECCI_PROXY_TOKEN;

if (!PROXY_URL || !TOKEN) {
  throw new Error("ECCI_PROXY_URL and ECCI_PROXY_TOKEN are required");
}

const FRED_SERIES = ["DGS10", "DGS2", "NFCI", "BAMLH0A0HYM2"];
const DATES = ["2000-03-24", "2002-10-09", "2007-10-09", "2008-11-20", "2009-03-09", "2020-03-23", "2022-10-12"];

async function main() {
  const [spy, vix, fredBatch] = await Promise.all([
    yahoo("SPY", "max"),
    cboeVix(),
    fred(FRED_SERIES),
  ]);

  const fredMap = new Map(fredBatch.results.map((result) => [
    result.seriesId,
    result.payload.observations
      .map((obs) => ({ date: obs.date, value: Number(obs.value) }))
      .filter((point) => Number.isFinite(point.value)),
  ]));

  const vixPoints = vix.map((point) => ({ date: point.date, value: point.close }));
  const vixValues = vixPoints.map((point) => point.value);
  const hy = fredMap.get("BAMLH0A0HYM2") ?? [];
  const nfci = fredMap.get("NFCI") ?? [];
  const dgs10 = fredMap.get("DGS10") ?? [];
  const dgs2 = fredMap.get("DGS2") ?? [];
  const hyValues = hy.map((point) => point.value);
  const nfciValues = nfci.map((point) => point.value);
  const curve = alignDiff(dgs10, dgs2);
  const curveValues = curve.map((point) => point.value);

  for (const date of DATES) {
    const idx = closestIndex(spy, date);
    const closesToDate = spy.slice(0, idx + 1).map((point) => point.close);
    const close = closesToDate.at(-1);
    const sma200 = avg(closesToDate.slice(-200));
    const distance = ((close - sma200) / sma200) * 100;
    const drawdown = ((close / Math.max(...closesToDate.slice(-252))) - 1) * 100;
    const momentum = ((close / closesToDate[Math.max(0, closesToDate.length - 253)]) - 1) * 100;
    const vixValue = nearest(vixPoints, date);
    const hyValue = nearest(hy, date);
    const nfciValue = nearest(nfci, date);
    const curveValue = nearest(curve, date);

    console.log({
      date,
      close: round(close),
      distance: round(distance),
      drawdown: round(drawdown),
      momentum: round(momentum),
      vix: round(vixValue),
      vixTopScore: round(topScore(100 - percentile(vixValues, vixValue))),
      hyOas: round(hyValue),
      hyTopScore: round(topScore(100 - percentile(hyValues, hyValue))),
      nfci: round(nfciValue),
      nfciTopScore: round(topScore(100 - percentile(nfciValues, nfciValue))),
      curve: round(curveValue),
      curveTopScore: round(topScore(100 - percentile(curveValues, curveValue))),
    });
  }
}

async function yahoo(symbol, range) {
  const query = range === "max" ? `period1=852076800&period2=${Math.floor(Date.now() / 1000)}&interval=1d` : `range=${range}&interval=1d`;
  const res = await fetch(`${PROXY_URL}/yahoo/v8/finance/chart/${encodeURIComponent(symbol)}?${query}`, {
    headers: { "X-Auth-Token": TOKEN },
  });
  const json = await res.json();
  const result = json.chart.result[0];
  const timestamps = result.timestamp ?? [];
  const closes = result.indicators.adjclose?.[0]?.adjclose ?? result.indicators.quote[0].close ?? [];
  return timestamps.map((ts, i) => ({ date: new Date(ts * 1000).toISOString().slice(0, 10), close: closes[i] })).filter((p) => Number.isFinite(p.close));
}

async function cboeVix() {
  const res = await fetch(`${PROXY_URL}/cboe/vix?symbol=VIX`, { headers: { "X-Auth-Token": TOKEN } });
  const csv = await res.text();
  return csv.trim().split(/\r?\n/).slice(1).map((line) => {
    const [date,,,, close] = line.split(",");
    const [m, d, y] = date.split("/");
    return { date: `${y}-${m.padStart(2, "0")}-${d.padStart(2, "0")}`, close: Number(close) };
  }).filter((p) => Number.isFinite(p.close));
}

async function fred(series) {
  const res = await fetch(`${PROXY_URL}/fred/batch?series=${series.join(",")}&observation_start=1990-01-01`, {
    headers: { "X-Auth-Token": TOKEN },
  });
  return res.json();
}

function alignDiff(left, right) {
  const rightMap = new Map(right.map((p) => [p.date, p.value]));
  return left.map((p) => rightMap.has(p.date) ? { date: p.date, value: p.value - rightMap.get(p.date) } : null).filter(Boolean);
}

function closestIndex(points, date) {
  let index = 0;
  for (let i = 0; i < points.length; i++) {
    if (points[i].date <= date) index = i;
    else break;
  }
  return index;
}

function nearest(points, date) {
  let value = NaN;
  for (const point of points) {
    if (point.date > date) break;
    value = point.value;
  }
  return value;
}

function percentile(values, current) {
  const clean = values.filter(Number.isFinite);
  return clean.filter((value) => value <= current).length / clean.length * 100;
}

function topScore(value) {
  const clipped = Math.max(0, Math.min(100, Number.isFinite(value) ? value : 50));
  const centered = (clipped - 50) / 50;
  const amplified = Math.sign(centered) * Math.pow(Math.abs(centered), 0.72);
  return 50 + amplified * 50;
}

function avg(values) {
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function round(value) {
  return Number.isFinite(value) ? Math.round(value * 100) / 100 : "n/a";
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
