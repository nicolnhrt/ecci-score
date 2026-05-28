import { drawHistoryChart, getChartTheme } from "./chart.js";
import { loadSnapshot } from "./data-client.js";
import { calculateCycleScore, getScoreBand, metricGroups } from "./ecci-core.js";

const els = {
  root: document.documentElement,
  main: document.querySelector(".main"),
  scoreValue: document.getElementById("scoreValue"),
  gaugeArc: document.getElementById("gaugeArc"),
  scoreBand: document.getElementById("scoreBand"),
  scoreUpdated: document.getElementById("scoreUpdated"),
  metricsGrid: document.getElementById("metricsGrid"),
  metricsHint: document.getElementById("metricsHint"),
  historyCaption: document.getElementById("historyCaption"),
  componentGrid: document.getElementById("componentGrid"),
  componentsHint: document.getElementById("componentsHint"),
  sourceLabel: document.querySelector("[data-source-label]"),
  chart: document.getElementById("historyChart"),
  themeToggle: document.querySelector("[data-theme-toggle]"),
};

let currentSnapshot = null;

initTheme();
window.addEventListener("DOMContentLoaded", init);
window.addEventListener("resize", debounce(() => renderChart(), 150));

async function init() {
  document.body.classList.add("is-loading");
  try {
    currentSnapshot = await loadSnapshot();
    renderSnapshot(currentSnapshot);
  } catch (error) {
    showError(error);
    renderEmptyState();
  } finally {
    document.body.classList.remove("is-loading");
  }
}

function renderSnapshot(snapshot) {
  const computedScore = calculateCycleScore(snapshot.metrics);
  const score = Number.isFinite(snapshot.score) ? snapshot.score : computedScore;
  const roundedScore = Math.round(score);
  const band = getScoreBand(score);

  els.sourceLabel.textContent = snapshot.sourceLabel || "Daily public snapshot";
  els.scoreValue.textContent = String(roundedScore);
  els.gaugeArc.style.strokeDashoffset = String(207 - (roundedScore / 100) * 207);
  els.scoreBand.className = `chip ${band.key}`;
  els.scoreBand.textContent = band.label;
  els.scoreUpdated.textContent = formatUpdatedAt(snapshot.updatedAt);
  els.metricsHint.textContent = `${snapshot.metrics.length} indicators - ${snapshot.universe?.label || "S&P 500"}`;

  const basePoints = snapshot.historySources?.base?.history?.length ?? 0;
  const recentPoints = snapshot.historySources?.recent?.history?.length ?? snapshot.history.length;
  els.historyCaption.textContent = `${snapshot.history.length} points - base ${basePoints} - recent ${recentPoints} - client recomputed score ${Math.round(computedScore)}`;

  renderMetrics(snapshot.metrics);
  renderComponents(snapshot.history);
  renderChart();
}

function renderMetrics(metrics) {
  els.metricsGrid.replaceChildren(...metrics.map((metric) => {
    const cls = metric.score < 40 ? "low" : metric.score >= 80 ? "high" : "mid";
    const group = metricGroups.find((item) => item.id === metric.group);
    const article = document.createElement("article");
    article.className = "metric-card";
    article.innerHTML = `
      <div class="metric-top">
        <div class="metric-name"></div>
        <div class="metric-score ${cls}">${Math.round(metric.score)}<span style="font-size:.52em">%</span></div>
      </div>
      <p class="metric-desc"></p>
      <div class="metric-bar-wrap" role="progressbar" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${Math.round(metric.score)}">
        <div class="metric-bar ${cls}"></div>
      </div>
      <div class="metric-meta"></div>
    `;
    article.querySelector(".metric-name").textContent = metric.label;
    article.querySelector(".metric-desc").textContent = metric.note;
    article.querySelector(".metric-meta").textContent = `${group?.label || metric.group} - ${metric.value || metric.source || "snapshot"}`;
    requestAnimationFrame(() => {
      article.querySelector(".metric-bar").style.width = `${Math.max(0, Math.min(100, metric.score))}%`;
    });
    return article;
  }));
}

function renderComponents(history) {
  const latest = [...(history || [])].reverse().find((point) => point.components);
  const components = latest?.components || {};
  const cards = metricGroups.map((group) => {
    const component = components[group.id] || {};
    const score = Number.isFinite(component.score) ? component.score : 0;
    const contribution = Number.isFinite(component.contribution) ? component.contribution : score * group.weight;
    const cls = score < 40 ? "low" : score >= 80 ? "high" : "mid";
    const article = document.createElement("article");
    article.className = "component-card";
    article.innerHTML = `
      <div class="component-top">
        <span class="component-label"></span>
        <span class="component-score ${cls}">${score.toFixed(1)}</span>
      </div>
      <div class="component-meta"></div>
      <div class="metric-bar-wrap" role="progressbar" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${Math.round(score)}">
        <div class="metric-bar ${cls}"></div>
      </div>
    `;
    article.querySelector(".component-label").textContent = group.label;
    article.querySelector(".component-meta").textContent = `Weight ${(group.weight * 100).toFixed(0)}% - contribution ${contribution.toFixed(2)}`;
    requestAnimationFrame(() => {
      article.querySelector(".metric-bar").style.width = `${Math.max(0, Math.min(100, score))}%`;
    });
    return article;
  });

  els.componentGrid.replaceChildren(...cards);
  els.componentsHint.textContent = latest?.date ? `Point date ${latest.date}` : "No component history";
}

function renderChart() {
  if (!currentSnapshot) return;
  drawHistoryChart(els.chart, currentSnapshot.history, getChartTheme());
}

function initTheme() {
  const savedTheme = localStorage.getItem("ecci-theme");
  const systemTheme = matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
  setTheme(savedTheme || els.root.dataset.theme || systemTheme);
  els.themeToggle.addEventListener("click", () => {
    setTheme(els.root.dataset.theme === "dark" ? "light" : "dark");
    renderChart();
  });
}

function setTheme(theme) {
  els.root.dataset.theme = theme;
  localStorage.setItem("ecci-theme", theme);
  els.themeToggle.textContent = theme === "dark" ? "Light" : "Dark";
  els.themeToggle.setAttribute("aria-label", theme === "dark" ? "Switch to light theme" : "Switch to dark theme");
}

function showError(error) {
  const box = document.createElement("div");
  box.className = "error-box";
  box.textContent = `Unable to load the ECCI snapshot: ${error.message}`;
  els.main.prepend(box);
}

function renderEmptyState() {
  els.scoreBand.textContent = "Data unavailable";
  els.metricsHint.textContent = "No JSON loaded";
  els.historyCaption.textContent = "No history loaded";
  els.componentsHint.textContent = "No component history";
}

function formatUpdatedAt(value) {
  if (!value) return "Unknown update time";
  return new Intl.DateTimeFormat("en-US", {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(new Date(value));
}

function debounce(fn, delay) {
  let timeoutId;
  return (...args) => {
    clearTimeout(timeoutId);
    timeoutId = setTimeout(() => fn(...args), delay);
  };
}
