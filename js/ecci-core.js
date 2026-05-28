export const metricGroups = [
  { id: "valuation", label: "Valuation", weight: 0.3 },
  { id: "trend", label: "Trend", weight: 0.25 },
  { id: "sentiment", label: "Sentiment", weight: 0.15 },
  { id: "macro", label: "Macro Liquidity", weight: 0.2 },
  { id: "stress", label: "Internal Stress", weight: 0.1 },
];

const capitulationMetricIds = new Set(["vix", "hy-oas", "nfci", "drawdown"]);

export function calculateEcciScore(metrics, useGroupWeights = true) {
  if (!Array.isArray(metrics) || metrics.length === 0) return 0;

  if (!useGroupWeights) {
    return average(metrics.map((metric) => metric.score));
  }

  return metricGroups.reduce((total, group) => {
    const groupMetrics = metrics.filter((metric) => metric.group === group.id);
    if (groupMetrics.length === 0) return total;
    return total + average(groupMetrics.map((metric) => metric.score)) * group.weight;
  }, 0);
}

export function calculateCycleScore(metrics) {
  const rawScore = calculateEcciScore(metrics);
  const stressPenalty = calculateStressPenalty(metrics);
  return clamp(rawScore - stressPenalty, 0, 100);
}

export function getScoreBand(score) {
  if (score < 20) return { key: "low", label: "Capitulation" };
  if (score < 40) return { key: "low", label: "Recovery" };
  if (score < 60) return { key: "mid", label: "Transition" };
  if (score < 80) return { key: "mid", label: "Expansion" };
  return { key: "high", label: "Euphoria / Fragility" };
}

function calculateStressPenalty(metrics) {
  const signals = metrics
    .filter((metric) => capitulationMetricIds.has(metric.id))
    .map((metric) => 100 - metric.score);

  if (signals.length === 0) return 0;
  return Math.max(0, average(signals) - 55) * 0.65;
}

function average(values) {
  const validValues = values.filter((value) => Number.isFinite(value));
  if (validValues.length === 0) return 0;
  return validValues.reduce((total, value) => total + value, 0) / validValues.length;
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}
