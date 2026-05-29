import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import * as XLSX from "xlsx";

const PROXY_URL = trimTrailingSlash(requiredEnv("ECCI_PROXY_URL"));
const PROXY_TOKEN = requiredEnv("ECCI_PROXY_TOKEN");
const MODE = process.argv.includes("--history-base") ? "history-base" : "daily";
const HISTORY_BASE_PATH = path.resolve("data/ecci-history-base.json");
const RECENT_PATH = path.resolve("data/ecci-recent.json");
const SNAPSHOT_PATH = path.resolve("data/ecci-snapshot.json");
const TARGET_HISTORY_START_DATE = "1997-01-01";
const RECENT_LOOKBACK_YEARS = 3;
const FRED_SERIES = ["DGS10", "DGS2", "FEDFUNDS", "CPIAUCSL", "DFII10", "NFCI", "BAMLH0A0HYM2"];
const BREADTH_SYMBOLS = [
  "AAPL", "MSFT", "NVDA", "AMZN", "META", "GOOGL", "GOOG", "BRK-B", "LLY", "AVGO",
  "JPM", "TSLA", "V", "XOM", "UNH", "MA", "COST", "WMT", "HD", "PG",
  "JNJ", "NFLX", "ABBV", "BAC", "CRM", "ORCL", "KO", "CVX", "AMD", "PEP",
];

const metricGroups = [
  { id: "valuation", label: "Valuation", weight: 0.3 },
  { id: "trend", label: "Trend", weight: 0.25 },
  { id: "sentiment", label: "Sentiment", weight: 0.15 },
  { id: "macro", label: "Macro Liquidity", weight: 0.2 },
  { id: "stress", label: "Internal Stress", weight: 0.1 },
];

async function main() {
  const bundle = await fetchSourceBundle({ includeEco3min: MODE === "history-base" });
  const built = buildMetrics(bundle);
  const strictHistory = buildStrictRealHistory(built.history, bundle);
  const score = Math.round(calculateCycleScore(built.metrics));

  if (MODE === "history-base") {
    const historyBase = buildHistoryFile({
      kind: "history-base",
      updatedAt: new Date().toISOString(),
      history: strictHistory,
      coverage: buildCoverage({ ...bundle, history: strictHistory }),
      warnings: bundle.warnings,
      sourceNote: "Long historical base. HY OAS is extended with Eco3min weekly CC BY 4.0 data before the FRED 3-year current window.",
    });
    await writeJson(HISTORY_BASE_PATH, historyBase);
    console.log(`Wrote ${HISTORY_BASE_PATH}`);
    console.log(`History base ${historyBase.coverage.historyStartDate} -> ${historyBase.coverage.historyEndDate}, ${historyBase.history.length} points`);
    return;
  }

  const recentStartDate = dateYearsAgo(RECENT_LOOKBACK_YEARS);
  const recentHistory = strictHistory.filter((point) => point.date >= recentStartDate);
  const recent = buildHistoryFile({
    kind: "recent",
    updatedAt: new Date().toISOString(),
    history: recentHistory,
    coverage: buildCoverage({ ...bundle, history: recentHistory }),
    warnings: bundle.warnings,
    sourceNote: "Daily recent history rebuilt from live sources. FRED HY OAS is used for the current 3-year window.",
  });

  const snapshot = {
    version: "1.0.0",
    updatedAt: new Date().toISOString(),
    sourceLabel: bundle.warnings.length > 0 ? "Daily real snapshot - partial" : "Daily real snapshot",
    universe: universeConfig(),
    methodology: methodology("snapshot"),
    score,
    metrics: built.metrics,
    history: recentHistory,
    historyFiles: {
      base: "./data/ecci-history-base.json",
      recent: "./data/ecci-recent.json",
    },
    warnings: bundle.warnings,
    coverage: buildCoverage({ ...bundle, history: recentHistory }),
  };

  await writeJson(RECENT_PATH, recent);
  await writeJson(SNAPSHOT_PATH, snapshot);
  console.log(`Wrote ${RECENT_PATH}`);
  console.log(`Wrote ${SNAPSHOT_PATH}`);
  console.log(`Score ${score}, metrics ${built.metrics.length}, recent history ${recentHistory.length} points`);
}

async function fetchSourceBundle({ includeEco3min }) {
  const warnings = [];
  const tasks = [
    fetchYahooChart("SPY", "max"),
    fetchYahooChart("RSP", "max"),
    fetchYahooChart("^VIX", "max"),
    fetchFredBatch(FRED_SERIES, "1900-01-01"),
    fetchText("/cboe/vix?symbol=VIX"),
    fetchShillerCape(),
    fetchBreadthSample(BREADTH_SYMBOLS),
  ];
  if (includeEco3min) tasks.push(fetchEco3minHyOas());

  const [spyResult, rspResult, vixYahooResult, fredResult, cboeResult, capeResult, breadthResult, eco3minHyResult] = await Promise.allSettled(tasks);
  const spy = unwrap(spyResult, "Yahoo SPY", warnings);
  const rsp = unwrap(rspResult, "Yahoo RSP", warnings) ?? [];
  const vixYahoo = unwrap(vixYahooResult, "Yahoo VIX", warnings) ?? [];
  const fredBatch = unwrap(fredResult, "FRED batch", warnings) ?? [];
  const cboeCsv = unwrap(cboeResult, "CBOE VIX", warnings);
  const cape = unwrap(capeResult, "Shiller CAPE", warnings) ?? [];
  const breadth = unwrap(breadthResult, "Yahoo breadth sample", warnings);
  const eco3minHyOas = eco3minHyResult ? unwrap(eco3minHyResult, "Eco3min HY OAS fallback", warnings) ?? [] : [];

  if (!spy || spy.length < 260) throw new Error("SPY unavailable or insufficient history");

  const vixFromCboe = cboeCsv ? parseCboeCsv(cboeCsv) : [];
  const vix = vixFromCboe.length > 500 ? vixFromCboe : vixYahoo;
  const fred = new Map(fredBatch.map((series) => [series.seriesId, series.points]));
  const fredHyOas = fred.get("BAMLH0A0HYM2") ?? [];
  if (eco3minHyOas.length > 0 && (eco3minHyOas.length > fredHyOas.length || eco3minHyOas[0]?.date < fredHyOas[0]?.date)) {
    fred.set("BAMLH0A0HYM2", mergeFredPoints(eco3minHyOas, fredHyOas));
    warnings.push("BAMLH0A0HYM2 extended with Eco3min weekly HY OAS fallback before FRED current window.");
  }

  return { spy, rsp, vix, fred, cape, breadth, warnings };
}

function buildHistoryFile({ kind, updatedAt, history, coverage, warnings, sourceNote }) {
  return {
    version: "1.0.0",
    kind,
    updatedAt,
    universe: universeConfig(),
    methodology: methodology(kind),
    history,
    warnings,
    coverage,
    sourceNote,
  };
}

function universeConfig() {
  return {
    id: "sp500",
    label: "S&P 500",
    shortLabel: "US Large Caps",
    benchmarkSymbol: "SPY",
    benchmarkName: "S&P 500",
    equalWeightSymbol: "RSP",
    valuationMode: "cape",
  };
}

function methodology(kind) {
  return {
    kind,
    targetHistoryStartDate: TARGET_HISTORY_START_DATE,
    recentLookbackYears: RECENT_LOOKBACK_YEARS,
    groups: metricGroups.map(({ id, label, weight }) => ({ id, label, weight })),
  };
}

async function fetchYahooChart(symbol, range) {
  const query = range === "max"
    ? `period1=852076800&period2=${Math.floor(Date.now() / 1000)}&interval=1d`
    : `range=${range}&interval=1d`;
  const payload = await fetchJson(`/yahoo/v8/finance/chart/${encodeURIComponent(symbol)}?${query}`);
  const result = payload.chart?.result?.[0];
  const timestamps = result?.timestamp ?? [];
  const closes = result?.indicators?.adjclose?.[0]?.adjclose ?? result?.indicators?.quote?.[0]?.close ?? [];
  return timestamps.map((timestamp, index) => {
    const close = closes[index];
    if (!Number.isFinite(close)) return null;
    return { date: new Date(timestamp * 1000).toISOString().slice(0, 10), close };
  }).filter(Boolean);
}

async function fetchFredBatch(series, observationStart) {
  const payload = await fetchJson(`/fred/batch?series=${series.join(",")}&observation_start=${observationStart}&limit=100000`);
  return payload.results.map((result) => ({
    seriesId: result.seriesId,
    points: (result.payload.observations ?? [])
      .map((observation) => ({ date: observation.date, value: Number(observation.value) }))
      .filter((point) => Number.isFinite(point.value)),
  }));
}

async function fetchShillerCape() {
  const buffer = await fetchArrayBuffer("/shiller/cape");
  const workbook = XLSX.read(buffer, { type: "array" });
  const sheet = workbook.Sheets.Data ?? workbook.Sheets[workbook.SheetNames[0]];
  const rows = XLSX.utils.sheet_to_json(sheet, { header: 1, raw: true });
  const headerIndex = rows.findIndex((row) => row[0] === "Date" && row.includes("CAPE"));
  const dataRows = headerIndex >= 0 ? rows.slice(headerIndex + 1) : rows;
  const capeIndex = headerIndex >= 0 ? rows[headerIndex].findIndex((cell) => cell === "CAPE") : 12;
  return dataRows.map((row) => {
    const decimalDate = Number(row[0]);
    const cape = Number(row[capeIndex]);
    if (!Number.isFinite(decimalDate) || !Number.isFinite(cape)) return null;
    const year = Math.floor(decimalDate);
    const month = Math.max(1, Math.min(12, Math.round((decimalDate - year) * 100)));
    return { date: `${year}-${String(month).padStart(2, "0")}-01`, cape };
  }).filter((point) => point && point.cape > 0);
}

async function fetchBreadthSample(symbols) {
  const payloads = await Promise.all(
    chunk(symbols, 10).map((symbolChunk) =>
      fetchJson(`/yahoo/v8/finance/spark?symbols=${encodeURIComponent(symbolChunk.join(","))}&range=2y&interval=1d`),
    ),
  );
  const mergedPayload = Object.assign({}, ...payloads);
  const states = Object.values(mergedPayload).map((item) => {
    const closes = (item.close ?? []).filter(Number.isFinite);
    if (closes.length < 200) return null;
    return last(closes) > average(closes.slice(-200));
  }).filter((value) => value !== null);
  if (states.length === 0) throw new Error("No valid breadth constituents");
  return { above200dma: (states.filter(Boolean).length / states.length) * 100, count: states.length };
}

async function fetchEco3minHyOas() {
  const csv = await fetchText("/eco3min/hy-oas");
  return parseEco3minHyOasCsv(csv);
}

function buildMetrics(input) {
  const spyCloses = input.spy.map((point) => point.close);
  const rspCloses = input.rsp.map((point) => point.close);
  const vixCloses = input.vix.map((point) => point.close);
  const spyCurrent = last(spyCloses);
  const spySma200 = average(spyCloses.slice(-200));
  const distance200 = ((spyCurrent - spySma200) / spySma200) * 100;
  const drawdownOneYear = ((spyCurrent / Math.max(...spyCloses.slice(-252))) - 1) * 100;
  const oneYearReturn = totalReturn(spyCloses, 252);
  const oneYearReturnHistory = rollingReturns(spyCloses, 252);
  const pricePercentile = percentileRank(spyCloses.slice(-252 * 5), spyCurrent);
  const capeValues = input.cape.map((point) => point.cape);
  const capeCurrent = last(capeValues);
  const capeScore = input.cape.length > 0 ? percentileRank(capeValues, capeCurrent) : pricePercentile;
  const dgs10 = input.fred.get("DGS10") ?? [];
  const dgs2 = input.fred.get("DGS2") ?? [];
  const fedFunds = input.fred.get("FEDFUNDS") ?? [];
  const cpi = input.fred.get("CPIAUCSL") ?? [];
  const realYield = input.fred.get("DFII10") ?? [];
  const nfci = input.fred.get("NFCI") ?? [];
  const hyOas = input.fred.get("BAMLH0A0HYM2") ?? [];
  const curve = alignFredDifference(dgs10, dgs2);
  const cpiInflation = yoy(cpi);
  const policyGap = alignFredDifference(fedFunds, cpiInflation);
  const spyRspRatio = input.rsp.length > 260 ? alignRatio(spyCloses, rspCloses) : [];
  const concentrationScore = spyRspRatio.length > 0 ? topScore(percentileRank(spyRspRatio, last(spyRspRatio))) : 50;
  const metrics = [
    metric("cape", "valuation", "Shiller CAPE Percentile", topScore(capeScore), latestDate(input.cape), "Yale/Shiller", formatNumber(capeCurrent), `Current CAPE: ${formatNumber(capeCurrent)}.`),
    metric("real-yield", "valuation", "10Y Real Yield Percentile", topScore(percentileRank(values(realYield), lastValue(realYield))), latestDate(realYield), "FRED DFII10", `${formatNumber(lastValue(realYield))}%`, "High real yields weigh on equity multiples."),
    metric("distance-200dma", "trend", "Distance to 200-Day Moving Average", topScore(scaleLinear(distance200, -18, 18)), latestDate(input.spy), "Yahoo SPY", `${formatNumber(distance200)}%`, "S&P 500 distance versus its 200-day moving average."),
    metric("one-year-momentum", "trend", "12-Month Momentum", topScore(percentileRank(oneYearReturnHistory, oneYearReturn)), latestDate(input.spy), "Yahoo SPY", `${formatNumber(oneYearReturn)}%`, "Trailing 12-month performance versus its rolling history."),
    metric("drawdown", "trend", "1-Year Drawdown", topScore(scaleLinear(drawdownOneYear, -35, 0)), latestDate(input.spy), "Yahoo SPY", `${formatNumber(drawdownOneYear)}%`, "Deeper drawdowns reduce the cycle score."),
    metric("breadth-sample", "trend", "Breadth Sample Above 200DMA", input.breadth?.above200dma ?? 50, latestDate(input.spy), `Yahoo spark (${input.breadth?.count ?? 0} constituents)`, input.breadth ? `${formatNumber(input.breadth.above200dma)}%` : "n/a", "Share of large-cap constituents trading above their 200-day moving average."),
    metric("vix", "sentiment", "VIX Complacency Score", topScore(100 - percentileRank(vixCloses, last(vixCloses))), latestDate(input.vix), "CBOE/Yahoo VIX", formatNumber(last(vixCloses)), "Low VIX implies complacency; high VIX implies capitulation and lowers the score."),
    metric("policy-gap", "macro", "Fed Funds Minus CPI YoY", topScore(percentileRank(values(policyGap), lastValue(policyGap))), latestDate(policyGap), "FRED", `${formatNumber(lastValue(policyGap))} pts`, "Gap between the policy rate and annual inflation."),
    metric("yield-curve", "macro", "10Y-2Y Yield Curve", topScore(100 - percentileRank(values(curve), lastValue(curve))), latestDate(curve), "FRED DGS10/DGS2", `${formatNumber(lastValue(curve))} pts`, "A low or inverted curve is treated as a late-cycle signal."),
    metric("nfci", "macro", "Financial Conditions Looseness", topScore(100 - percentileRank(values(nfci), lastValue(nfci))), latestDate(nfci), "FRED NFCI", formatNumber(lastValue(nfci)), "Loose conditions raise the score; tight conditions lower it."),
    metric("hy-oas", "stress", "High Yield OAS Complacency", topScore(100 - percentileRank(values(hyOas), lastValue(hyOas))), latestDate(hyOas), "FRED BAMLH0A0HYM2", formatNumber(lastValue(hyOas)), "Low spreads imply complacency; high spreads imply capitulation."),
    metric("equal-weight", "stress", "SPY vs RSP Concentration", concentrationScore, latestDate(input.rsp), "Yahoo SPY/RSP", spyRspRatio.length > 0 ? `${formatPercentile(percentileRank(spyRspRatio, last(spyRspRatio)))}` : "n/a", "Measures cap-weight dominance versus equal-weight exposure."),
  ];
  return { metrics, history: buildScoreHistory(input.spy, input.vix, input.fred, input.cape) };
}

function buildScoreHistory(spy, vix, fred, cape) {
  const spyCloses = spy.map((point) => point.close);
  const vixByDate = nearestMap(vix.map((point) => ({ date: point.date, value: point.close })));
  const hyByDate = nearestMap(fred.get("BAMLH0A0HYM2") ?? []);
  const nfciByDate = nearestMap(fred.get("NFCI") ?? []);
  const dgs10ByDate = nearestMap(fred.get("DGS10") ?? []);
  const dgs2ByDate = nearestMap(fred.get("DGS2") ?? []);
  const capeByDate = nearestMap(cape.map((point) => ({ date: point.date, value: point.cape })));
  const capeValues = cape.map((point) => point.cape);
  const vixValues = vix.map((point) => point.close);
  const hyValues = values(fred.get("BAMLH0A0HYM2") ?? []);
  const nfciValues = values(fred.get("NFCI") ?? []);
  const curveValues = alignFredDifference(fred.get("DGS10") ?? [], fred.get("DGS2") ?? []).map((point) => point.value);
  return spy.filter((point) => point.date >= TARGET_HISTORY_START_DATE).map((point, filteredIndex) => {
    const index = spy.findIndex((candidate) => candidate.date === point.date);
    const closesToDate = spyCloses.slice(0, index + 1);
    const sma200 = average(closesToDate.slice(-200));
    const distance = ((last(closesToDate) - sma200) / sma200) * 100;
    const drawdown = ((last(closesToDate) / Math.max(...closesToDate.slice(-252))) - 1) * 100;
    const momentum = totalReturn(closesToDate, Math.min(252, closesToDate.length - 1));
    const vixValue = vixByDate.get(point.date);
    const hyValue = hyByDate.get(point.date);
    const nfciValue = nfciByDate.get(point.date);
    const dgs10Value = dgs10ByDate.get(point.date);
    const dgs2Value = dgs2ByDate.get(point.date);
    const curveValue = dgs10Value !== undefined && dgs2Value !== undefined ? dgs10Value - dgs2Value : undefined;
    const capeValue = capeByDate.get(point.date);
    const synthetic = [
      { id: "h-cape", group: "valuation", score: topScore(capeValue ? percentileRank(capeValues, capeValue) : percentileRank(closesToDate, last(closesToDate))) },
      { id: "h-distance", group: "trend", score: topScore(scaleLinear(distance, -18, 18)) },
      { id: "h-momentum", group: "trend", score: topScore(scaleLinear(momentum, -30, 35)) },
      { id: "drawdown", group: "trend", score: topScore(scaleLinear(drawdown, -35, 0)) },
      { id: "vix", group: "sentiment", score: topScore(vixValue ? 100 - percentileRank(vixValues, vixValue) : 50) },
      { id: "nfci", group: "macro", score: topScore(nfciValue ? 100 - percentileRank(nfciValues, nfciValue) : 50) },
      { id: "h-curve", group: "macro", score: topScore(curveValue !== undefined ? 100 - percentileRank(curveValues, curveValue) : 50) },
      { id: "hy-oas", group: "stress", score: topScore(hyValue ? 100 - percentileRank(hyValues, hyValue) : 50) },
    ];
    const historyPoint = {
      index: "ECCI-SP500",
      score: roundTo(calculateCycleScore(synthetic), 1),
      date: point.date,
      components: buildHistoryComponents(synthetic, point.close),
    };
    if (filteredIndex === 0) historyPoint.coverage = "real-common-history-start";
    return historyPoint;
  });
}

function buildHistoryComponents(metrics, spyClose) {
  return Object.fromEntries(metricGroups.map((group) => {
    const groupMetrics = metrics.filter((metric) => metric.group === group.id);
    const score = groupMetrics.length > 0 ? average(groupMetrics.map((metric) => metric.score)) : 0;
    const component = {
      score: roundTo(score, 1),
      weight: group.weight,
      contribution: roundTo(score * group.weight, 2),
    };
    if (group.id === "valuation") component.spyClose = spyClose;
    return [group.id, component];
  }));
}

function buildStrictRealHistory(history, { vix, fred, cape }) {
  const requiredStarts = [
    history[0]?.date,
    vix[0]?.date,
    cape[0]?.date,
    fred.get("DGS10")?.[0]?.date,
    fred.get("DGS2")?.[0]?.date,
    fred.get("NFCI")?.[0]?.date,
    fred.get("BAMLH0A0HYM2")?.[0]?.date,
  ].filter(Boolean);
  const strictStart = requiredStarts.sort().at(-1);
  return strictStart ? history.filter((point) => point.date >= strictStart) : history;
}

function buildCoverage({ spy, rsp, vix, fred, cape, breadth, history }) {
  const series = [
    coverageItem("Yahoo SPY", spy),
    coverageItem("Yahoo RSP", rsp),
    coverageItem("CBOE/Yahoo VIX", vix),
    coverageItem("Yale/Shiller CAPE", cape),
    coverageItem("FRED DGS10", fred.get("DGS10") ?? []),
    coverageItem("FRED DGS2", fred.get("DGS2") ?? []),
    coverageItem("FRED FEDFUNDS", fred.get("FEDFUNDS") ?? []),
    coverageItem("FRED CPIAUCSL", fred.get("CPIAUCSL") ?? []),
    coverageItem("FRED DFII10", fred.get("DFII10") ?? []),
    coverageItem("FRED NFCI", fred.get("NFCI") ?? []),
    coverageItem("HY OAS", fred.get("BAMLH0A0HYM2") ?? []),
  ];
  return {
    targetHistoryStartDate: TARGET_HISTORY_START_DATE,
    historyStartDate: history[0]?.date ?? null,
    historyEndDate: last(history)?.date ?? null,
    historyPoints: history.length,
    breadthSampleCount: breadth?.count ?? 0,
    series,
  };
}

function coverageItem(label, points) {
  return { label, start: points[0]?.date ?? null, end: last(points)?.date ?? null, points: points.length };
}

async function fetchJson(route) {
  const response = await fetch(`${PROXY_URL}${route}`, { headers: authHeaders() });
  if (!response.ok) throw new Error(`${route} returned ${response.status}`);
  return response.json();
}

async function fetchText(route) {
  const response = await fetch(`${PROXY_URL}${route}`, { headers: authHeaders() });
  if (!response.ok) throw new Error(`${route} returned ${response.status}`);
  return response.text();
}

async function fetchArrayBuffer(route) {
  const response = await fetch(`${PROXY_URL}${route}`, { headers: authHeaders() });
  if (!response.ok) throw new Error(`${route} returned ${response.status}`);
  return response.arrayBuffer();
}

function authHeaders() {
  return { "X-Auth-Token": PROXY_TOKEN };
}

function calculateEcciScore(metrics, useGroupWeights = true) {
  if (metrics.length === 0) return 0;
  if (!useGroupWeights) return average(metrics.map((metric) => metric.score));
  return metricGroups.reduce((total, group) => {
    const groupMetrics = metrics.filter((metric) => metric.group === group.id);
    if (groupMetrics.length === 0) return total;
    return total + average(groupMetrics.map((metric) => metric.score)) * group.weight;
  }, 0);
}

function calculateCycleScore(metrics) {
  const rawScore = calculateEcciScore(metrics);
  const stressPenalty = calculateStressPenalty(metrics);
  return Math.max(0, Math.min(100, rawScore - stressPenalty));
}

function calculateStressPenalty(metrics) {
  const capitulationMetricIds = new Set(["vix", "hy-oas", "nfci", "drawdown"]);
  const capitulationSignals = metrics
    .filter((metric) => capitulationMetricIds.has(metric.id))
    .map((metric) => 100 - metric.score);
  if (capitulationSignals.length === 0) return 0;
  return Math.max(0, average(capitulationSignals) - 55) * 0.65;
}

function metric(id, group, label, score, updatedAt, source, value, note) {
  return { id, group, label, score: roundScore(score), note, updatedAt, source, value };
}

function unwrap(result, label, warnings) {
  if (result.status === "fulfilled") return result.value;
  warnings.push(`${label}: ${result.reason instanceof Error ? result.reason.message : String(result.reason)}`);
  return null;
}

function parseCboeCsv(csv) {
  return csv.trim().split(/\r?\n/).slice(1).map((line) => {
    const [date, , , , close] = line.split(",");
    const [month, day, year] = date.split("/");
    const value = Number(close);
    if (!month || !day || !year || !Number.isFinite(value)) return null;
    return { date: `${year}-${month.padStart(2, "0")}-${day.padStart(2, "0")}`, close: value };
  }).filter(Boolean);
}

function parseEco3minHyOasCsv(csv) {
  const [headerLine, ...lines] = csv.trim().split(/\r?\n/);
  const headers = headerLine.split(",").map((item) => item.trim());
  const dateIndex = headers.indexOf("date");
  const hyIndex = headers.indexOf("hy_oas");
  if (dateIndex < 0 || hyIndex < 0) throw new Error("Eco3min HY OAS CSV missing date or hy_oas columns");
  return lines.map((line) => {
    const columns = line.split(",");
    const date = columns[dateIndex];
    const value = Number(columns[hyIndex]);
    if (!date || !Number.isFinite(value)) return null;
    return { date, value };
  }).filter(Boolean);
}

function mergeFredPoints(basePoints, overlayPoints) {
  const merged = new Map();
  for (const point of basePoints) merged.set(point.date, point.value);
  for (const point of overlayPoints) merged.set(point.date, point.value);
  return [...merged.entries()].map(([date, value]) => ({ date, value })).sort((a, b) => a.date.localeCompare(b.date));
}

function alignFredDifference(left, right) {
  const rightByDate = new Map(right.map((point) => [point.date, point.value]));
  return left.map((point) => {
    const rightValue = rightByDate.get(point.date);
    return rightValue === undefined ? null : { date: point.date, value: point.value - rightValue };
  }).filter(Boolean);
}

function yoy(points) {
  return points.map((point, index) => {
    const prior = points[index - 12];
    return prior ? { date: point.date, value: ((point.value / prior.value) - 1) * 100 } : null;
  }).filter(Boolean);
}

function alignRatio(left, right) {
  const length = Math.min(left.length, right.length);
  return left.slice(-length).map((value, index) => value / right.slice(-length)[index]).filter(Number.isFinite);
}

function rollingReturns(items, period) {
  return items.map((value, index) => {
    const prior = items[index - period];
    return prior ? ((value / prior) - 1) * 100 : null;
  }).filter((value) => value !== null && Number.isFinite(value));
}

function totalReturn(items, period) {
  const prior = items[Math.max(0, items.length - period - 1)];
  return ((last(items) / prior) - 1) * 100;
}

function percentileRank(items, current) {
  const cleanValues = items.filter(Number.isFinite);
  if (cleanValues.length === 0 || !Number.isFinite(current)) return 50;
  return (cleanValues.filter((value) => value <= current).length / cleanValues.length) * 100;
}

function nearestMap(points) {
  const sorted = [...points].sort((a, b) => a.date.localeCompare(b.date));
  return {
    get: (date) => {
      let previous;
      for (const point of sorted) {
        if (point.date > date) break;
        previous = point.value;
      }
      return previous;
    },
  };
}

function scaleLinear(value, min, max) {
  return ((value - min) / (max - min)) * 100;
}

function average(items) {
  const cleanValues = items.filter(Number.isFinite);
  return cleanValues.length === 0 ? 0 : cleanValues.reduce((total, value) => total + value, 0) / cleanValues.length;
}

function values(points) {
  return points.map((point) => point.value);
}

function lastValue(points) {
  return points[points.length - 1]?.value ?? Number.NaN;
}

function latestDate(points) {
  return points[points.length - 1]?.date ?? "n/a";
}

function last(items) {
  return items[items.length - 1];
}

function chunk(items, size) {
  const chunks = [];
  for (let index = 0; index < items.length; index += size) chunks.push(items.slice(index, index + size));
  return chunks;
}

function roundScore(value) {
  return Math.round(Math.max(0, Math.min(100, Number.isFinite(value) ? value : 50)));
}

function roundTo(value, decimals) {
  if (!Number.isFinite(value)) return 0;
  const factor = 10 ** decimals;
  return Math.round(value * factor) / factor;
}

function topScore(value) {
  const clipped = Math.max(0, Math.min(100, Number.isFinite(value) ? value : 50));
  const centered = (clipped - 50) / 50;
  const amplified = Math.sign(centered) * Math.pow(Math.abs(centered), 0.72);
  return 50 + amplified * 50;
}

function formatNumber(value) {
  if (!Number.isFinite(value)) return "n/a";
  return new Intl.NumberFormat("en-US", { maximumFractionDigits: 2 }).format(value);
}

function formatPercentile(value) {
  return `${roundScore(value)}e`;
}

function dateYearsAgo(years) {
  const date = new Date();
  date.setUTCFullYear(date.getUTCFullYear() - years);
  return date.toISOString().slice(0, 10);
}

async function writeJson(filePath, payload) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
}

function trimTrailingSlash(value) {
  return value.replace(/\/+$/, "");
}

function requiredEnv(name) {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
