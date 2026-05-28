export function drawHistoryChart(canvas, history, theme) {
  const ctx = canvas.getContext("2d");
  const pixelRatio = window.devicePixelRatio || 1;
  const width = canvas.clientWidth || canvas.width;
  const height = canvas.clientHeight || canvas.height;

  canvas.width = Math.floor(width * pixelRatio);
  canvas.height = Math.floor(height * pixelRatio);
  ctx.setTransform(pixelRatio, 0, 0, pixelRatio, 0, 0);
  ctx.clearRect(0, 0, width, height);

  const points = history.filter((point) => Number.isFinite(point.score));
  if (points.length < 2) return;

  const pad = { top: 18, right: 16, bottom: 28, left: 36 };
  const chartWidth = width - pad.left - pad.right;
  const chartHeight = height - pad.top - pad.bottom;
  const xFor = (index) => pad.left + (index / (points.length - 1)) * chartWidth;
  const yFor = (score) => pad.top + (1 - score / 100) * chartHeight;

  ctx.strokeStyle = theme.grid;
  ctx.lineWidth = 1;
  ctx.font = "11px Geist Mono, monospace";
  ctx.fillStyle = theme.text;
  [0, 25, 50, 75, 100].forEach((tick) => {
    const y = yFor(tick);
    ctx.beginPath();
    ctx.moveTo(pad.left, y);
    ctx.lineTo(width - pad.right, y);
    ctx.stroke();
    ctx.fillText(String(tick), 4, y + 4);
  });

  const gradient = ctx.createLinearGradient(0, pad.top, 0, height - pad.bottom);
  gradient.addColorStop(0, theme.fill);
  gradient.addColorStop(1, "transparent");

  ctx.beginPath();
  points.forEach((point, index) => {
    const x = xFor(index);
    const y = yFor(point.score);
    if (index === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  });
  ctx.lineTo(width - pad.right, height - pad.bottom);
  ctx.lineTo(pad.left, height - pad.bottom);
  ctx.closePath();
  ctx.fillStyle = gradient;
  ctx.fill();

  ctx.beginPath();
  points.forEach((point, index) => {
    const x = xFor(index);
    const y = yFor(point.score);
    if (index === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  });
  ctx.strokeStyle = theme.line;
  ctx.lineWidth = 2;
  ctx.stroke();

  const last = points[points.length - 1];
  ctx.fillStyle = theme.line;
  ctx.beginPath();
  ctx.arc(xFor(points.length - 1), yFor(last.score), 4, 0, Math.PI * 2);
  ctx.fill();
}

export function getChartTheme() {
  const style = getComputedStyle(document.documentElement);
  return {
    line: style.getPropertyValue("--color-primary").trim(),
    fill: colorWithAlpha(style.getPropertyValue("--color-primary").trim(), 0.16),
    grid: colorWithAlpha(style.getPropertyValue("--color-text").trim(), 0.08),
    text: style.getPropertyValue("--color-text-muted").trim(),
  };
}

function colorWithAlpha(color, alpha) {
  if (color.startsWith("#")) {
    const hex = color.slice(1);
    const value = Number.parseInt(hex.length === 3 ? hex.split("").map((x) => x + x).join("") : hex, 16);
    const red = (value >> 16) & 255;
    const green = (value >> 8) & 255;
    const blue = value & 255;
    return `rgb(${red} ${green} ${blue} / ${alpha})`;
  }
  return color;
}
