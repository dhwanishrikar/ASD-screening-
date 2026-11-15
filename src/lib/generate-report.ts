import { jsPDF } from "jspdf";
import html2canvas from "html2canvas";
import type { ChildInfo, ScreeningResult } from "./screening-data";
import type { BackendResult } from "@/pages/Index";
import { getAllQuestionsFlat, type AdaptiveQuestion } from "./adaptive-questions";

/* "caretaker" is kept as an alias of "parent" so older callers keep working. */
export type ReportAudience = "parent" | "caretaker" | "clinician";

/* Reports built by the backend (one per audience, charts embedded as images). */
type BackendReports = { parent?: string; clinician?: string };

const isParentAudience = (a: ReportAudience) => a !== "clinician";

/*
 * false = the PDF is always built from the local template in this file
 *         (radar, pie, bars, SHAP "Why this result?" chart).
 * true  = use the HTML the backend sends in `reports` when it exists.
 *         That HTML does NOT contain the local charts.
 */
const USE_BACKEND_REPORTS = false;

const OBSERVATION_LABELS: Record<string, string> = {
  A1: "Responding when their name is called",
  A2: "Eye contact",
  A3: "Pointing to request something",
  A4: "Pointing to share interest",
  A5: "Pretend play",
  A6: "Following another person's gaze",
  A7: "Showing comfort toward someone who is upset",
  A8: "Early speech development",
  A9: "Use of simple gestures",
  A10: "Episodes of unexplained staring",
  A11: "Smiling back at another person",
  A12: "Bringing objects to share interest",
  A13: "Following a person's point",
  A14: "Interest in parts of objects",
  A15: "Interest in playing around other children",
  A16: "Distress from everyday sounds",
  A17: "Combining two or more words",
  A18: "Looking to a caregiver for social cues",
  A19: "Strong attachment to unusual objects",
  A20: "Imitating another person's actions",
};

/*
 * TDSC milestone ranges currently available in this project.
 * Kept exactly as the existing project data. Do not invent additional ranges.
 */
const TDSC_MILESTONES = [
  ["Social smile", 0.1, 2.7],
  ["Eyes follow pen/pencil", 1.1, 3.9],
  ["Holds head steady", 1.1, 3.8],
  ["Rolls from back to stomach", 2.7, 10.0],
  ["Turns head to sound of bell/rattle", 3.0, 5.8],
  ["Transfers objects hand to hand", 4.1, 7.0],
  ["Raises self to sitting position", 5.8, 11.0],
  ["Standing up by furniture", 6.3, 11.0],
  ["Fine prehension pellet", 6.7, 10.9],
  ["Pat-a-cake", 6.7, 12.7],
  ["Walks with help", 7.7, 13.0],
  ["Throws ball", 9.5, 16.7],
  ["Walks alone", 9.9, 17.7],
  ["Says two words", 11.2, 19.1],
  ["Walks backwards", 12.2, 19.5],
  ["Walks upstairs with help", 12.2, 24.4],
  ["Points to parts of a doll (3 parts)", 15.3, 24.3],
] as const;

const esc = (value: unknown) =>
  String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");

function ageLabel(months: number) {
  const years = Math.floor(months / 12);
  const remaining = months % 12;
  if (!years) return `${months} months`;
  return `${months} months (${years} year${years === 1 ? "" : "s"}${
    remaining ? ` ${remaining} month${remaining === 1 ? "" : "s"}` : ""
  })`;
}

function dateLabel(iso?: string) {
  const d = iso ? new Date(iso) : new Date();
  const opts: Intl.DateTimeFormatOptions = { day: "2-digit", month: "long", year: "numeric" };
  if (Number.isNaN(d.getTime())) return new Date().toLocaleDateString("en-IN", opts);
  return d.toLocaleDateString("en-IN", opts);
}

function genderLabel(gender: string) {
  return gender === "m" ? "Male" : gender === "f" ? "Female" : gender || "Not specified";
}

function getRiskLevel(backendResult: BackendResult | null, fallbackResult: ScreeningResult | null) {
  if (backendResult) return backendResult.risk_level;
  const map: Record<string, string> = { none: "Low", level1: "Moderate", level2: "High", level3: "Very High" };
  return fallbackResult ? map[fallbackResult.riskLevel] ?? "Low" : "Low";
}

function resultMessage(riskLevel: string) {
  const messages: Record<string, { title: string; body: string }> = {
    Low: {
      title: "The screening responses did not identify a high level of ASD-related indicators.",
      body: "Continue routine developmental monitoring and discuss any concerns with the child's healthcare professional.",
    },
    Moderate: {
      title: "The screening responses indicate some areas that may need further attention.",
      body: "Consider discussing the observed developmental areas with the child's pediatrician or another qualified developmental professional.",
    },
    High: {
      title: "The screening responses indicate several areas that would benefit from further attention.",
      body: "A professional developmental evaluation is recommended so that the child's strengths and support needs can be understood more fully.",
    },
    "Very High": {
      title: "The screening responses indicate multiple areas of concern that should be discussed with a qualified professional.",
      body: "Please arrange a developmental evaluation. The screening result does not establish a diagnosis.",
    },
  };
  return (
    messages[riskLevel] ?? {
      title: "The screening responses identified areas for further discussion.",
      body: "Please discuss the result with a qualified healthcare professional.",
    }
  );
}

function questionFlag(q: AdaptiveQuestion, answerIndex: number) {
  return q.reverseScored ? answerIndex <= 2 : answerIndex >= 2;
}

function getDomainScores(backendResult: BackendResult | null, fallbackResult: ScreeningResult | null) {
  if (backendResult?.domain_scores?.length) {
    return backendResult.domain_scores.map((d) => ({
      domain: d.domain,
      percentage: d.percentage,
      interpretation: d.interpretation,
      flags: d.flag_items ?? [],
    }));
  }

  const fallbackMap = [
    ["Social Interaction", fallbackResult?.scores.social.score ?? 0],
    ["Communication", fallbackResult?.scores.communication.score ?? 0],
    ["Behavioral Patterns", fallbackResult?.scores.behavior.score ?? 0],
  ] as const;

  return fallbackMap.map(([domain, percentage]) => ({
    domain: domain as string,
    percentage: percentage as number,
    interpretation:
      percentage < 30
        ? "Fewer responses in this area were flagged."
        : percentage < 55
          ? "Some responses in this area were flagged and may be worth monitoring."
          : "Several responses in this area were flagged and merit further discussion.",
    flags: [] as string[],
  }));
}

function observationData(answers: Record<string, number>, backendResult: BackendResult | null) {
  const allQuestions = getAllQuestionsFlat();

  const rows = Object.entries(answers)
    .map(([id, answerIndex]) => {
      const q = allQuestions[id];
      if (!q) return null;

      const answer = q.options[answerIndex] ?? "Response recorded";
      const backendFlag = backendResult?.domain_scores?.some((d) => d.flag_items?.includes(id)) ?? false;
      const flag = backendResult ? backendFlag : questionFlag(q, answerIndex);

      return { id, q, answer, flag, label: OBSERVATION_LABELS[id] ?? q.text };
    })
    .filter(Boolean) as Array<{ id: string; q: AdaptiveQuestion; answer: string; flag: boolean; label: string }>;

  return {
    flagged: rows.filter((r) => r.flag).slice(0, 8),
    other: rows.filter((r) => !r.flag).slice(0, 4),
    all: rows,
  };
}

function recommendationsForReport(
  backendResult: BackendResult | null,
  riskLevel: string,
  domains: ReturnType<typeof getDomainScores>,
) {
  if (backendResult?.recommendations) {
    const primary = backendResult.recommendations.primary ?? [];
    const domain = (backendResult.recommendations.domain_specific ?? []).map((r) => r.replace(/^\[.*?\]\s*/, ""));
    return [...primary, ...domain].slice(0, 10);
  }

  const common =
    riskLevel === "Low"
      ? [
          "Continue routine developmental check-ups and share any new concerns with your child's pediatrician.",
          "Use everyday play, books, songs, and face-to-face interaction to encourage communication and shared attention.",
          "Keep a simple note of developmental changes that concern you so you can discuss them at the next visit.",
        ]
      : [
          "Discuss the screening result and flagged developmental areas with your child's pediatrician or a qualified developmental professional.",
          "Consider a developmental assessment, especially if the flagged behaviours are also seen consistently in everyday life.",
          "Use face-to-face play, shared reading, pointing games, imitation, and turn-taking activities to support social communication.",
        ];

  const domainExtras = domains
    .filter((d) => d.percentage >= 50)
    .map((d) => {
      if (d.domain === "Communication")
        return "If communication is a concern, discuss speech and language support with a qualified professional.";
      if (d.domain === "Behavioral Patterns")
        return "If sensory or behaviour concerns interfere with daily life, discuss them with the child's healthcare professional.";
      return "Use child-led, turn-taking play to encourage social interaction and shared attention.";
    });

  return [...common, ...domainExtras].slice(0, 8);
}

/* ============================================================
   SHARED CHART PALETTE
   ============================================================ */

const VISUAL_PALETTE = ["#2563eb", "#7a2331", "#e2a33d", "#0f766e", "#7c3aed"];
const paletteColor = (index: number) => VISUAL_PALETTE[index % VISUAL_PALETTE.length];

/* ============================================================
   DOMAIN PIE CHART
   ============================================================ */

function buildDomainPieHtml(
  domains: ReturnType<typeof getDomainScores>,
  observations: ReturnType<typeof observationData>,
) {
  const counts = domains.map((d, i) => ({
    domain: d.domain,
    count: observations.all.filter((o) => o.q.domain === d.domain && o.flag).length,
    color: paletteColor(i),
  }));

  const total = counts.reduce((sum, c) => sum + c.count, 0);

  const head = `
    <div class="visual-title">Flagged items by domain</div>
    <div class="visual-note">Share of all flagged responses contributed by each screening domain.</div>`;

  if (total === 0) {
    return `<div class="visual-card">${head}<div class="muted">No flagged responses were available to chart.</div></div>`;
  }

  const cx = 60;
  const cy = 60;
  const r = 50;
  let angleStart = -90;

  const slices = counts
    .filter((c) => c.count > 0)
    .map((c) => {
      const sliceAngle = (c.count / total) * 360;
      const angleEnd = angleStart + sliceAngle;
      const largeArc = sliceAngle > 180 ? 1 : 0;
      const startRad = (Math.PI / 180) * angleStart;
      const endRad = (Math.PI / 180) * angleEnd;

      const x1 = cx + r * Math.cos(startRad);
      const y1 = cy + r * Math.sin(startRad);
      const x2 = cx + r * Math.cos(endRad);
      const y2 = cy + r * Math.sin(endRad);

      /* A single slice covering 100% needs a circle: an arc can't start and end at the same point. */
      const path =
        sliceAngle >= 359.99
          ? `M ${cx} ${cy - r} A ${r} ${r} 0 1 1 ${cx - 0.01} ${cy - r} Z`
          : `M ${cx} ${cy} L ${x1.toFixed(2)} ${y1.toFixed(2)} A ${r} ${r} 0 ${largeArc} 1 ${x2.toFixed(2)} ${y2.toFixed(2)} Z`;

      angleStart = angleEnd;
      return { path, color: c.color };
    });

  const pathsSvg = slices
    .map((s) => `<path d="${s.path}" fill="${s.color}" stroke="#ffffff" stroke-width="1.5" />`)
    .join("");

  const legend = counts
    .map(
      (c) => `
        <div class="pie-legend-item">
          <span class="pie-swatch" style="background:${c.color}"></span>
          <span>${esc(c.domain)}: <strong>${c.count}</strong> flagged (${((c.count / total) * 100).toFixed(0)}%)</span>
        </div>`,
    )
    .join("");

  return `
    <div class="visual-card">
      ${head}
      <div class="pie-wrap">
        <svg class="pie-svg" width="120" height="120" viewBox="0 0 120 120">${pathsSvg}</svg>
        <div class="pie-legend">${legend}</div>
      </div>
    </div>`;
}

/* ============================================================
   DOMAIN RADAR CHART
   ============================================================ */

function buildDomainRadarHtml(domains: ReturnType<typeof getDomainScores>) {
  const n = domains.length;
  if (n < 3) return "";

  const cx = 80;
  const cy = 80;
  const maxR = 46;
  const angleStep = (2 * Math.PI) / n;
  const startAngle = -Math.PI / 2;

  const axisPoint = (i: number, r: number) => {
    const angle = startAngle + i * angleStep;
    return { x: cx + r * Math.cos(angle), y: cy + r * Math.sin(angle) };
  };

  const rings = [0.25, 0.5, 0.75, 1]
    .map((frac) => {
      const pts = Array.from({ length: n }, (_, i) => axisPoint(i, maxR * frac));
      const pointsAttr = pts.map((p) => `${p.x.toFixed(2)},${p.y.toFixed(2)}`).join(" ");
      return `<polygon points="${pointsAttr}" fill="none" stroke="#d9dee8" stroke-width="1" />`;
    })
    .join("");

  const axisLines = Array.from({ length: n }, (_, i) => {
    const p = axisPoint(i, maxR);
    return `<line x1="${cx}" y1="${cy}" x2="${p.x.toFixed(2)}" y2="${p.y.toFixed(2)}" stroke="#d9dee8" stroke-width="1" />`;
  }).join("");

  const dataPts = domains.map((d, i) => {
    const pct = Math.max(0, Math.min(100, Number(d.percentage) || 0));
    return axisPoint(i, maxR * (pct / 100));
  });

  const dataPointsAttr = dataPts.map((p) => `${p.x.toFixed(2)},${p.y.toFixed(2)}`).join(" ");

  const dots = dataPts
    .map((p) => `<circle cx="${p.x.toFixed(2)}" cy="${p.y.toFixed(2)}" r="2.6" fill="#2563eb" />`)
    .join("");

  const labels = domains
    .map((d, i) => {
      const p = axisPoint(i, maxR + 18);
      const anchor = Math.abs(p.x - cx) < 4 ? "middle" : p.x > cx ? "start" : "end";
      return `<text x="${p.x.toFixed(2)}" y="${p.y.toFixed(2)}" font-size="7.5" fill="#334155" text-anchor="${anchor}" dominant-baseline="middle">${esc(d.domain)}</text>`;
    })
    .join("");

  return `
    <div class="visual-card">
      <div class="visual-title">Domain profile shape</div>
      <div class="visual-note">
        Relative pattern of flagged indicators across screening domains — a wider shape toward an edge
        means more indicators were flagged in that area.
      </div>
      <div class="radar-wrap">
        <svg width="190" height="170" viewBox="0 0 190 170">
          ${rings}${axisLines}
          <polygon points="${dataPointsAttr}" fill="rgba(37,99,235,0.28)" stroke="#2563eb" stroke-width="1.6" />
          ${dots}${labels}
        </svg>
      </div>
    </div>`;
}

/* ============================================================
   SCREENING VISUALS
   ============================================================ */

function buildScreeningVisualHtml(
  domains: ReturnType<typeof getDomainScores>,
  observations: ReturnType<typeof observationData>,
  score: number | null,
) {
  const domainRows = domains
    .map((d) => {
      const pct = Math.max(0, Math.min(100, Number(d.percentage) || 0));
      return `
        <div class="bar-row">
          <div class="bar-label">${esc(d.domain)}</div>
          <div class="bar-track"><div class="bar-fill" style="width:${pct.toFixed(1)}%"></div></div>
          <div class="bar-value">${pct.toFixed(1)}%</div>
        </div>`;
    })
    .join("");

  const total = observations.all.length;

  /* Use observations.all: observations.flagged is intentionally limited to 8 for the report text. */
  const flagged = observations.all.filter((r) => r.flag).length;
  const notFlagged = Math.max(0, total - flagged);
  const flaggedPct = total > 0 ? (flagged / total) * 100 : 0;
  const notFlaggedPct = total > 0 ? (notFlagged / total) * 100 : 0;

  const safeScore = score === null ? null : Math.max(0, Math.min(100, Number(score) || 0));

  return `
    <div class="visuals">

      <div class="visual-card">
        <div class="visual-title">Screening result at a glance</div>
        <div class="visual-note">This visual summarizes the screening score. It is not a measure of autism severity.</div>
        ${
          safeScore !== null
            ? `
              <div class="score-row">
                <div class="score-number">${safeScore.toFixed(1)}<span>/100</span></div>
                <div class="score-area">
                  <strong>Overall screening score</strong>
                  <div class="score-track"><div class="score-fill" style="width:${safeScore.toFixed(1)}%"></div></div>
                  <div class="scale"><span>Lower</span><span>More indicators</span></div>
                </div>
              </div>`
            : `<div class="muted">No overall numeric score was available.</div>`
        }
      </div>

      <div class="visual-card">
        <div class="visual-title">Indicators by screening domain</div>
        <div class="visual-note">Percentage of scored items flagged within each screening domain.</div>
        <div class="bar-chart">
          ${domainRows || `<div class="muted">No domain scores were available.</div>`}
        </div>
      </div>

      <div class="visual-card">
        <div class="visual-title">Recorded response distribution</div>
        <div class="visual-note">Distribution of recorded responses according to the screening rules.</div>
        <div class="response-bar">
          <div class="response-flagged" style="width:${flaggedPct.toFixed(2)}%"></div>
          <div class="response-normal" style="width:${notFlaggedPct.toFixed(2)}%"></div>
        </div>
        <div class="legend">
          <span>Flagged: <strong>${flagged}</strong></span>
          <span>Not flagged: <strong>${notFlagged}</strong></span>
          <span>Total: <strong>${total}</strong></span>
        </div>
      </div>

      ${buildDomainPieHtml(domains, observations)}
      ${buildDomainRadarHtml(domains)}

    </div>`;
}

/* ============================================================
   TDSC CHART
   ============================================================ */

function buildTdscChartHtml(ageMonths: number) {
  /*
   * 0–36 month developmental-age scale (maroon/gold banner, cream body,
   * a gridline per month, alternating maroon/orange bars, label to the left
   * of each bar's start). The child's age is shown above the chart, not as a line.
   */
  const maxAge = 36;

  const ticks = Array.from({ length: maxAge }, (_, i) => i + 1)
    .map((month) => `<span>${month}</span>`)
    .join("");

  const rows = TDSC_MILESTONES.map(([label, start, end], index) => {
    const left = (start / maxAge) * 100;
    const width = Math.max(1.4, ((end - start) / maxAge) * 100);
    const altClass = index % 2 === 0 ? "alt-a" : "alt-b";

    return `
      <div class="tdsc-row">
        <div class="tdsc-track">
          <div class="tdsc-label" style="left:${left.toFixed(2)}%">${index + 1} ${esc(label)}</div>
          <div class="tdsc-range ${altClass}" style="left:${left.toFixed(2)}%;width:${width.toFixed(2)}%"></div>
        </div>
      </div>`;
  }).join("");

  return `
    <div class="tdsc-card">
      <div class="tdsc-title">TRIVANDRUM DEVELOPMENTAL SCREENING CHART (TDSC) 0–3 YEARS</div>
      <div class="tdsc-subtitle">
        Child chronological age: <strong>${esc(ageMonths)} months</strong>
        <span class="tdsc-separator">•</span>
        Developmental reference scale: 0–36 months
      </div>
      <div class="tdsc-body">${rows}</div>
      <div class="tdsc-axis-title">AGE IN MONTHS</div>
      <div class="tdsc-axis">${ticks}</div>
      <div class="tdsc-footer-bar">CHILD DEVELOPMENT CENTRE (CDC), MEDICAL COLLEGE, THIRUVANANTHAPURAM</div>
      <div class="tdsc-note">
        This is a TDSC reference visual. It does not calculate developmental age or determine whether an
        individual milestone has been achieved. The current ASD questionnaire does not assess every TDSC item.
      </div>
    </div>`;
}

/* ============================================================
   SHAP "WHY THIS RESULT?" SECTION
   Diverging bar chart (risk right / protective left) + factor chips.
   Data comes from backendResult.explainability. Returns "" when
   explainability is unavailable, so the report is unchanged in that case.
   ============================================================ */

function buildShapSectionHtml(backendResult: BackendResult | null): string {
  const exp = backendResult?.explainability;
  if (!exp?.available) return "";

  const feats = [...(exp.top_positive ?? []), ...(exp.top_negative ?? [])].sort(
    (a, b) => Math.abs(b.contribution_pct) - Math.abs(a.contribution_pct),
  );
  if (!feats.length) return "";

  const vals = feats.map((f) => f.contribution_pct);
  const min = Math.min(0, ...vals);
  const max = Math.max(0, ...vals);
  const span = max - min || 1;
  const zero = (-min / span) * 100;

  const rows = feats
    .map((f) => {
      const risk = f.direction === "risk";
      const w = Math.max(0.8, (Math.abs(f.contribution_pct) / span) * 100);
      const left = risk ? zero : zero - w;
      const sign = f.contribution_pct > 0 ? "+" : "";
      return `
        <div class="shap-row">
          <div class="shap-label">${esc(f.label)}</div>
          <div class="shap-track">
            <div class="shap-zero" style="left:${zero.toFixed(2)}%"></div>
            <div class="shap-bar ${risk ? "risk" : "prot"}" style="left:${left.toFixed(2)}%;width:${w.toFixed(2)}%"></div>
          </div>
          <div class="shap-val ${risk ? "risk-t" : "prot-t"}">${sign}${f.contribution_pct.toFixed(1)}%</div>
        </div>`;
    })
    .join("");

  const chip = (f: (typeof feats)[number], cls: string) =>
    `<div class="chip ${cls}"><span>${esc(f.label)}</span><strong>${f.contribution_pct > 0 ? "+" : ""}${f.contribution_pct.toFixed(Math.abs(f.contribution_pct) < 1 ? 1 : 0)}%</strong></div>`;

  return `
  <section>
    <h2>Why this result? — contributing factors</h2>
    ${exp.plain_explanation ? `<p>${esc(exp.plain_explanation)}</p>` : ""}
    <div class="shap-chart">${rows}</div>
    <div class="chip-grid">
      <div>
        <div class="chip-title risk-t">Increased risk</div>
        ${(exp.top_positive ?? []).map((f) => chip(f, "chip-risk")).join("")}
      </div>
      <div>
        <div class="chip-title prot-t">Protective factors</div>
        ${(exp.top_negative ?? []).map((f) => chip(f, "chip-prot")).join("")}
      </div>
    </div>
    <p class="muted">
      Powered by SHAP (${esc(exp.model_basis ?? "Random Forest")}). Contributions are percentage points of predicted
      ASD-risk probability, computed against a background of typical screening responses. This is decision support,
      not a diagnosis.
    </p>
  </section>`;
}

/* ============================================================
   LOCAL (OFFLINE FALLBACK) REPORT HTML
   Used only when the backend did not return an audience report.
   ============================================================ */

export function buildCaretakerReportHtml(
  childInfo: ChildInfo,
  answers: Record<string, number>,
  backendResult: BackendResult | null,
  fallbackResult: ScreeningResult | null,
  audience: ReportAudience = "parent",
) {
  const parent = isParentAudience(audience);
  const riskLevel = getRiskLevel(backendResult, fallbackResult);
  const { title, body } = resultMessage(riskLevel);

  const score = backendResult?.overall_score ?? (fallbackResult ? fallbackResult.totalScore * 10 : null);

  const domains = getDomainScores(backendResult, fallbackResult);
  const observations = observationData(answers, backendResult);
  const recommendations = recommendationsForReport(backendResult, riskLevel, domains);
  const screeningDate = dateLabel(backendResult?.screening_date);

  const flaggedHtml = observations.flagged.length
    ? observations.flagged
        .map(
          (o) => `
            <li>
              <strong>${esc(o.label)}:</strong> the response was <em>${esc(o.answer)}</em>.
              This response was flagged by the screening rules for this area.
            </li>`,
        )
        .join("")
    : `<li>No individual responses were flagged by the screening rules.</li>`;

  const otherHtml = observations.other.length
    ? observations.other
        .map((o) => `<li><strong>${esc(o.label)}:</strong> the response was <em>${esc(o.answer)}</em>.</li>`)
        .join("")
    : `<li>No additional unflagged observations were included.</li>`;

  const profileHtml = domains
    .map((d) => {
      const pct = Math.max(0, Math.min(100, Number(d.percentage) || 0));
      const interpretation =
        pct < 30
          ? "Fewer responses in this area were flagged by the screening rules."
          : pct < 55
            ? "Some responses in this area were flagged and may be worth monitoring."
            : "Several responses in this area were flagged and merit further discussion.";

      return `
        <div class="domain-card">
          <div class="domain-head"><span>${esc(d.domain)}</span><strong>${pct.toFixed(1)}%</strong></div>
          <div class="track"><div class="fill" style="width:${pct.toFixed(1)}%"></div></div>
          <p>${esc(interpretation)}</p>
        </div>`;
    })
    .join("");

  const shapHtml = buildShapSectionHtml(backendResult);
  const recommendationHtml = recommendations.map((r) => `<li>${esc(r)}</li>`).join("");
  const tdscChartHtml = buildTdscChartHtml(childInfo.ageMonths);
  const screeningVisualHtml = buildScreeningVisualHtml(domains, observations, score);

  const comparisonHtml = backendResult?.comparison
    ? `
      <section>
        <h2>Previous screening</h2>
        <div class="comparison">
          <div><span>Previous score</span><strong>${backendResult.comparison.previous_score.toFixed(1)}</strong></div>
          <div><span>Current score</span><strong>${score?.toFixed(1) ?? "—"}</strong></div>
          <div><span>Change</span><strong>${esc(backendResult.comparison.direction)}</strong></div>
        </div>
        <p class="muted">
          This comparison uses screening history already stored for this child. A change in a screening score
          does not by itself indicate a change in diagnosis.
        </p>
      </section>`
    : "";

  const responseRows = observations.all
    .map(
      (o) => `
        <tr>
          <td>${esc(o.id)}</td>
          <td>${esc(o.q.domain)}</td>
          <td>${esc(o.label)}</td>
          <td>${esc(o.answer)}</td>
          <td class="${o.flag ? "flag" : "ok"}">${o.flag ? "Flagged" : "Not flagged"}</td>
        </tr>`,
    )
    .join("");

  const kicker = parent ? "parent report" : "healthcare professional report";
  const footerLabel = parent ? "Parent report" : "Healthcare professional report";

  return `
<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<title>Developmental Screening Report — ${esc(childInfo.name)}</title>
<style>
* { box-sizing: border-box; }
body { font-family: Arial, Helvetica, sans-serif; color: #1f2937; background: #ffffff; margin: 0; padding: 0; line-height: 1.5; font-size: 12px; }
.container { width: 100%; max-width: 794px; margin: 0 auto; padding: 0 30px 18px; }
.header { border-bottom: 3px solid #2563eb; padding: 26px 0 20px; margin-bottom: 28px; }
.kicker { font-size: 9px; text-transform: uppercase; letter-spacing: .12em; color: #64748b; font-weight: 700; }
h1 { font-size: 25px; margin: 5px 0; color: #172554; }
h2 { font-size: 16px; color: #1e3a8a; border-bottom: 1px solid #dbeafe; padding-bottom: 6px; margin: 22px 0 11px; }
h3 { font-size: 13px; margin: 13px 0 7px; color: #334155; }
section { margin-bottom: 18px; }
.info-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; }
.info { border: 1px solid #e5e7eb; border-radius: 8px; padding: 9px 11px; background: #f8fafc; }
.label { font-size: 9px; text-transform: uppercase; color: #64748b; letter-spacing: .05em; }
.value { font-size: 12px; font-weight: 600; margin-top: 2px; }
.summary { border: 1px solid #bfdbfe; background: #eff6ff; border-radius: 12px; padding: 16px; }
.summary strong { font-size: 15px; color: #1e3a8a; }
.notice { margin-top: 10px; padding: 9px 11px; border-radius: 8px; background: #fff7ed; border: 1px solid #fed7aa; color: #9a3412; }
.profile { display: grid; gap: 8px; }
.domain-card { border: 1px solid #e5e7eb; border-radius: 10px; padding: 10px; background: #ffffff; }
.domain-head { display: flex; justify-content: space-between; font-size: 12px; margin-bottom: 7px; }
.track { height: 9px; background: #e5e7eb; border-radius: 20px; overflow: hidden; }
.fill { height: 100%; background: #3b82f6; border-radius: 20px; }
.domain-card p { font-size: 10.5px; color: #64748b; margin: 6px 0 0; }
ul { padding-left: 19px; }
li { margin: 7px 0; }
.observation-list li { margin: 8px 0; }
.flag { color: #b91c1c; font-weight: 700; }
.ok { color: #166534; }
.muted { color: #64748b; font-size: 10.5px; }
table { width: 100%; border-collapse: collapse; font-size: 9.5px; table-layout: fixed; }
th, td { border: 1px solid #e5e7eb; padding: 6px 7px; text-align: left; vertical-align: top; overflow-wrap: anywhere; word-break: break-word; }
thead { display: table-header-group; }
tr { break-inside: avoid; page-break-inside: avoid; }
th { background: #f1f5f9; color: #475569; }

.visuals { display: grid; gap: 10px; margin-top: 12px; }
.visual-card { border: 1px solid #dbe3ec; border-radius: 10px; background: #ffffff; padding: 12px; }
.visual-title { font-size: 12px; font-weight: 800; color: #1e3a8a; margin-bottom: 3px; }
.visual-note { font-size: 9.5px; color: #64748b; margin-bottom: 9px; }
.score-row { display: grid; grid-template-columns: 78px 1fr; gap: 12px; align-items: center; }
.score-number { font-size: 19px; font-weight: 800; color: #1e3a8a; }
.score-number span { font-size: 9px; color: #64748b; }
.score-track { height: 11px; background: #e5e7eb; border-radius: 10px; overflow: hidden; margin-top: 5px; }
.score-fill { height: 100%; background: #2563eb; border-radius: 10px; }
.scale { display: flex; justify-content: space-between; font-size: 9px; color: #94a3b8; }
.bar-chart { display: grid; gap: 7px; }
.bar-row { display: grid; grid-template-columns: 150px 1fr 45px; gap: 7px; align-items: center; }
.bar-label { font-size: 9.5px; color: #334155; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.bar-track { height: 11px; background: #eef2f7; border: 1px solid #dbe3ec; border-radius: 8px; overflow: hidden; }
.bar-fill { height: 100%; background: #4f7ec9; border-radius: 7px; }
.bar-value { text-align: right; font-size: 9px; font-weight: 700; color: #334155; }
.response-bar { display: flex; height: 15px; width: 100%; border-radius: 8px; overflow: hidden; background: #eef2f7; border: 1px solid #dbe3ec; }
.response-flagged { background: #c96a6a; }
.response-normal { background: #8bb89a; }
.legend { display: flex; flex-wrap: wrap; gap: 10px 18px; margin-top: 7px; font-size: 8.5px; color: #64748b; }
.pie-wrap { display: flex; align-items: center; gap: 16px; }
.pie-svg { flex: 0 0 auto; }
.pie-legend { display: grid; gap: 6px; }
.pie-legend-item { display: flex; align-items: flex-start; gap: 6px; font-size: 9.5px; color: #334155; }
.pie-swatch { width: 10px; height: 10px; border-radius: 2px; margin-top: 2px; flex: 0 0 auto; }
.radar-wrap { display: flex; justify-content: center; }

.tdsc-card { border: 1px solid #7a2331; border-radius: 8px; background: #fdf4d0; overflow: hidden; }
.tdsc-title { background: #7a2331; color: #f6e6b4; text-align: center; font-weight: 800; font-size: 12.5px; letter-spacing: .02em; padding: 9px 8px; }
.tdsc-subtitle { font-size: 9.5px; text-align: center; color: #5c3a1e; background: #fdf4d0; padding: 7px 8px 4px; }
.tdsc-separator { margin: 0 5px; }
.tdsc-body { position: relative; margin: 2px 8px 4px 68px; padding: 6px 8px 4px 0; background-image: linear-gradient(to right, rgba(122, 35, 49, 0.35) 1px, transparent 1px); background-size: calc(100% / 36) 100%; background-repeat: repeat-x; }
.tdsc-row { position: relative; height: 19px; }
.tdsc-track { position: relative; height: 100%; }
.tdsc-label { position: absolute; top: 0; height: 100%; display: flex; align-items: center; white-space: nowrap; font-size: 8px; font-weight: 700; color: #2b1a10; transform: translateX(-100%); padding-right: 4px; }
.tdsc-range { position: absolute; top: 4px; height: 11px; border: 1px solid #5c1420; border-radius: 1px; }
.tdsc-range.alt-a { background: #7a2331; }
.tdsc-range.alt-b { background: #e2a33d; }
.tdsc-axis-title { text-align: center; font-size: 8.5px; font-weight: 700; color: #5c3a1e; margin: 2px 0 3px; }
.tdsc-axis { display: grid; grid-template-columns: repeat(36, 1fr); margin: 0 8px 0 68px; font-size: 7px; font-weight: 600; color: #5c3a1e; padding: 0 8px 6px 0; }
.tdsc-axis span { text-align: center; }
.tdsc-footer-bar { background: #7a2331; color: #f6e6b4; text-align: center; font-weight: 800; font-size: 9.5px; letter-spacing: .02em; padding: 7px 8px; }
.tdsc-note { margin: 7px 10px 9px; font-size: 9px; line-height: 1.35; color: #5c3a1e; }

.comparison { display: grid; grid-template-columns: repeat(3, 1fr); gap: 8px; }
.comparison div { padding: 10px; background: #f8fafc; border: 1px solid #e5e7eb; border-radius: 8px; }
.comparison span { display: block; font-size: 9px; color: #64748b; text-transform: uppercase; }
.comparison strong { font-size: 15px; }
.score-pill { display: inline-block; padding: 4px 9px; border-radius: 999px; background: #eef2ff; color: #3730a3; font-weight: 700; }
.overall-track { height: 12px; background: #e5e7eb; border-radius: 20px; overflow: hidden; margin: 8px 0 3px; }
.overall-fill { height: 100%; background: #2563eb; border-radius: 20px; }
.scale-labels { display: flex; justify-content: space-between; font-size: 9px; color: #94a3b8; }
.disclaimer { margin-top: 28px; padding: 13px; border: 1px solid #cbd5e1; background: #f8fafc; border-radius: 9px; color: #475569; font-size: 10px; }
.footer { margin-top: 34px; padding-top: 14px; border-top: 1px solid #e2e8f0; text-align: center; color: #94a3b8; font-size: 9px; }

.shap-chart { border: 1px solid #e5e7eb; border-radius: 10px; padding: 10px; margin: 10px 0; }
.shap-row { display: grid; grid-template-columns: 200px 1fr 52px; gap: 8px; align-items: center; min-height: 26px; }
.shap-label { font-size: 9.5px; color: #475569; text-align: right; }
.shap-track { position: relative; height: 14px; }
.shap-zero { position: absolute; top: -3px; bottom: -3px; width: 1px; background: #94a3b8; }
.shap-bar { position: absolute; top: 1px; height: 12px; border-radius: 3px; }
.shap-bar.risk { background: #ef4444; }
.shap-bar.prot { background: #10b981; }
.shap-val { font-size: 9.5px; font-weight: 700; }
.risk-t { color: #b91c1c; }
.prot-t { color: #047857; }
.chip-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; }
.chip-title { font-size: 9px; font-weight: 700; text-transform: uppercase; margin-bottom: 5px; }
.chip { display: flex; justify-content: space-between; gap: 8px; padding: 7px 9px; margin-bottom: 5px; border-radius: 8px; font-size: 10.5px; }
.chip-risk { background: #fef2f2; border: 1px solid #fecaca; color: #991b1b; }
.chip-prot { background: #ecfdf5; border: 1px solid #a7f3d0; color: #065f46; }
</style>
</head>
<body>
<div class="container">

  <div class="header">
    <div class="kicker">ASD early screening • ${esc(kicker)}</div>
    <h1>Developmental &amp; Behavioural Screening Report</h1>
    <div class="muted">Prepared for ${esc(childInfo.name)} · Screening date: ${esc(screeningDate)}</div>
  </div>

  <section>
    <h2>1. Child summary</h2>
    <div class="info-grid">
      <div class="info"><div class="label">Child</div><div class="value">${esc(childInfo.name)}</div></div>
      <div class="info"><div class="label">Age</div><div class="value">${esc(ageLabel(childInfo.ageMonths))}</div></div>
      <div class="info"><div class="label">Sex</div><div class="value">${esc(genderLabel(childInfo.gender))}</div></div>
      <div class="info"><div class="label">Screening completed by</div><div class="value">${esc(childInfo.completedBy || "Not specified")}</div></div>
      ${
        childInfo.ethnicity
          ? `<div class="info"><div class="label">Ethnicity</div><div class="value">${esc(childInfo.ethnicity)}</div></div>`
          : ""
      }
      <div class="info"><div class="label">Family history of ASD</div><div class="value">${childInfo.familyASD ? "Reported" : "Not reported"}</div></div>
      <div class="info"><div class="label">History of neonatal jaundice</div><div class="value">${childInfo.jaundice ? "Reported" : "Not reported"}</div></div>
    </div>
  </section>

  <section>
    <h2>2. Screening summary</h2>
    <div class="summary">
      <strong>${esc(title)}</strong>
      ${
        score !== null
          ? `
            <p><span class="score-pill">Screening score: ${score.toFixed(1)} / 100</span></p>
            <div class="overall-track"><div class="overall-fill" style="width:${Math.max(0, Math.min(100, score))}%"></div></div>
            <div class="scale-labels"><span>Lower</span><span>More indicators</span></div>`
          : ""
      }
      <p>${esc(body)}</p>
      <div class="notice">
        <strong>Important:</strong> This is a screening result, not a diagnosis of autism spectrum disorder.
        The result should be considered together with the child's development, history, and a professional
        evaluation when needed.
      </div>
    </div>
    ${screeningVisualHtml}
  </section>

  <section>
    <h2>3. Developmental and behavioural profile</h2>
    <p class="muted">These percentages show the proportion of scored items in each area that were flagged by the screening system. They are not measures of autism severity and should not be interpreted as a diagnosis.</p>
    <div class="profile">${profileHtml}</div>
  </section>

  ${shapHtml}

  <section>
    <h2>4. Developmental screening visual — TDSC reference</h2>
    <p class="muted">
      The Trivandrum Developmental Screening Chart (TDSC) is a developmental-delay screening tool. This visual
      presents the available milestone ranges on a 0–36 month developmental-age scale. The child's chronological
      age is shown separately and is not drawn as a vertical marker.
    </p>
    ${tdscChartHtml}
  </section>

  <section>
    <h2>5. Specific observations from this screening</h2>
    <h3>Responses that were flagged</h3>
    <ul class="observation-list">${flaggedHtml}</ul>
    <h3>Other recorded responses</h3>
    <ul class="observation-list">${otherHtml}</ul>
  </section>

  <section>
    <h2>6. What this means</h2>
    <p>${esc(title)}</p>
    <p>${esc(body)}</p>
    <p class="muted">
      The result reflects the answers provided during this screening session. It should not be used on its own
      to confirm or rule out autism or another developmental condition.
    </p>
  </section>

  <section>
    <h2>7. ${parent ? "What the caretaker can do" : "Suggested actions"}</h2>
    <ul>${recommendationHtml}</ul>
  </section>

  <section>
    <h2>8. When to discuss the result with a professional</h2>
    <p>
      If the screening identifies areas of concern, or if you have concerns about your child's communication,
      social interaction, play, behaviour, or development, discuss them with a pediatrician, developmental
      pediatrician, child psychologist, speech-language professional, or another qualified developmental
      professional. Bring this report and examples from everyday life to the appointment.
    </p>
    <p class="muted">
      If a child has lost skills they previously had, or you are concerned about a sudden or significant
      developmental change, contact the child's healthcare professional promptly rather than waiting for a
      repeat screening.
    </p>
  </section>

  ${comparisonHtml}

  <section>
    <h2>9. Recorded screening responses</h2>
    <p class="muted">
      This table preserves the responses actually provided in this screening session. Follow-up questions are
      included when they were answered.
    </p>
    <table>
      <colgroup>
        <col style="width:7%"><col style="width:19%"><col style="width:31%"><col style="width:25%"><col style="width:18%">
      </colgroup>
      <thead>
        <tr><th>Item</th><th>Area</th><th>Observation</th><th>Response</th><th>Screening flag</th></tr>
      </thead>
      <tbody>
        ${responseRows || `<tr><td colspan="5">No questionnaire responses were available.</td></tr>`}
      </tbody>
    </table>
  </section>

  <div class="disclaimer">
    <strong>Screening disclaimer:</strong> This document supports early screening and discussion with a
    healthcare/developmental professional. It is not a clinical diagnosis and does not determine whether a child
    has autism spectrum disorder. The report should be interpreted in the context of the child's full
    developmental history and, when indicated, a comprehensive professional assessment.
  </div>

  <div class="footer">Early ASD Screening System · ${esc(footerLabel)} · Generated ${esc(screeningDate)}</div>

</div>
</body>
</html>`;
}

/* ============================================================
   PDF GENERATION
   ============================================================ */

export async function generatePDFReport(
  childInfo: ChildInfo,
  answers: Record<string, number>,
  backendResult: BackendResult | null,
  fallbackResult: ScreeningResult | null,
  audience: ReportAudience = "parent",
): Promise<Blob> {
  /*
   * Preferred: the audience-specific report (with charts) built by the backend.
   * Fallback (backend offline / older backend): the local template above.
   */
  const backendReports = USE_BACKEND_REPORTS
    ? (backendResult as (BackendResult & { reports?: BackendReports }) | null)?.reports
    : undefined;
  const html =
    (isParentAudience(audience) ? backendReports?.parent : backendReports?.clinician) ??
    buildCaretakerReportHtml(childInfo, answers, backendResult, fallbackResult, audience);

  /* Diagnostic: open DevTools > Console after clicking Download to see which source was used. */
  console.info("[TinyTots PDF]", {
    templateSource: backendReports?.parent || backendReports?.clinician ? "BACKEND reports HTML" : "LOCAL template (with charts)",
    shapAvailable: backendResult?.explainability?.available ?? false,
    domainScores: backendResult?.domain_scores?.length ?? 0,
  });

  const container = document.createElement("div");
  container.style.position = "absolute";
  container.style.left = "0";
  container.style.top = "0";
  container.style.width = "794px";
  container.style.background = "#ffffff";
  container.style.zIndex = "-1";

  container.innerHTML = html;
  document.body.appendChild(container);

  try {
    await new Promise((resolve) => setTimeout(resolve, 100));

    /* Make sure every embedded chart image has finished loading before capture. */
    await Promise.all(
      Array.from(container.querySelectorAll("img")).map((img) =>
        img.complete
          ? Promise.resolve()
          : new Promise<void>((res) => {
              img.onload = () => res();
              img.onerror = () => res();
            }),
      ),
    );

    const canvas = await html2canvas(container, {
      scale: 2,
      useCORS: true,
      backgroundColor: "#ffffff",
      logging: false,
      width: 794,
      windowWidth: 794,
      scrollX: 0,
      scrollY: 0,
    });

    const pdf = new jsPDF({ unit: "pt", format: "a4", orientation: "portrait" });
    const pageWidth = pdf.internal.pageSize.getWidth();
    const pageHeight = pdf.internal.pageSize.getHeight();

    /* Space reserved for the repeating PDF header and footer. */
    const headerHeight = 58;
    const topContent = 74;
    const bottomContent = 56;
    const contentHeight = pageHeight - topContent - bottomContent;

    const pxPerPage = Math.max(1, Math.floor((contentHeight * canvas.width) / pageWidth));

    /* Convert browser coordinates into canvas pixel coordinates. */
    const containerRect = container.getBoundingClientRect();
    const renderScale = canvas.width / Math.max(1, containerRect.width);

    /*
     * Block boundaries, so a section / card / chart is not cut in half when
     * there is room to move it to the next page. The backend reports use
     * <section> (clinician) and .card / figure (parent) blocks.
     */
    const sectionBounds = Array.from(
      container.querySelectorAll("section, .card, figure, .hero, .impression"),
    ).map((el) => {
      const rect = el.getBoundingClientRect();
      const top = Math.max(0, (rect.top - containerRect.top) * renderScale);
      const bottom = Math.max(top, (rect.bottom - containerRect.top) * renderScale);
      return { top, bottom, height: bottom - top };
    });

    const getNextBreak = (currentOffset: number) => {
      const nominal = Math.min(canvas.height, currentOffset + pxPerPage);

      const crossing = sectionBounds.find(
        (s) =>
          s.top > currentOffset + 40 * renderScale &&
          s.top < nominal &&
          s.bottom > nominal &&
          s.height < pxPerPage,
      );

      return crossing ? crossing.top : nominal;
    };

    let offset = 0;
    let page = 0;

    const generatedDate = dateLabel(backendResult?.screening_date);
    const reportTitle = isParentAudience(audience) ? "Parent Report" : "Healthcare Professional Report";

    while (offset < canvas.height) {
      const nextBreak = getNextBreak(offset);
      const sliceHeight = Math.max(1, Math.min(nextBreak - offset, canvas.height - offset));

      const pageCanvas = document.createElement("canvas");
      pageCanvas.width = canvas.width;
      pageCanvas.height = sliceHeight;

      const ctx = pageCanvas.getContext("2d");
      if (!ctx) throw new Error("Unable to create report page canvas.");

      ctx.fillStyle = "#ffffff";
      ctx.fillRect(0, 0, pageCanvas.width, pageCanvas.height);
      ctx.drawImage(canvas, 0, offset, canvas.width, sliceHeight, 0, 0, canvas.width, sliceHeight);

      if (page > 0) pdf.addPage();

      /* Repeating HEADER */
      pdf.setFillColor(245, 248, 252);
      pdf.rect(0, 0, pageWidth, headerHeight, "F");

      pdf.setDrawColor(37, 99, 235);
      pdf.setLineWidth(2);
      pdf.line(0, headerHeight, pageWidth, headerHeight);

      pdf.setTextColor(23, 37, 84);
      pdf.setFont("helvetica", "bold");
      pdf.setFontSize(11);
      pdf.text("Early ASD Screening", 38, 26);

      pdf.setFont("helvetica", "normal");
      pdf.setFontSize(8.5);
      pdf.setTextColor(71, 85, 105);
      pdf.text(reportTitle, 38, 41);
      pdf.text(`Child: ${childInfo.name}`, pageWidth - 38, 26, { align: "right" });
      pdf.text(`Screening date: ${generatedDate}`, pageWidth - 38, 41, { align: "right" });

      /* REPORT CONTENT */
      const renderedHeight = (sliceHeight * pageWidth) / canvas.width;
      pdf.addImage(pageCanvas.toDataURL("image/png"), "PNG", 0, topContent, pageWidth, renderedHeight);

      /* Repeating FOOTER */
      const footerY = pageHeight - 28;

      pdf.setDrawColor(203, 213, 225);
      pdf.setLineWidth(0.7);
      pdf.line(38, pageHeight - bottomContent + 8, pageWidth - 38, pageHeight - bottomContent + 8);

      pdf.setFont("helvetica", "normal");
      pdf.setFontSize(7.5);
      pdf.setTextColor(100, 116, 139);
      pdf.text(`TinyTots • ${reportTitle} • Confidential`, 38, footerY);

      offset += sliceHeight;
      page += 1;
    }

    /* "Page X of Y" once the total page count is known. */
    const totalPages = pdf.getNumberOfPages();

    for (let i = 1; i <= totalPages; i++) {
      pdf.setPage(i);
      pdf.setFont("helvetica", "normal");
      pdf.setFontSize(7.5);
      pdf.setTextColor(100, 116, 139);
      pdf.text(`Page ${i} of ${totalPages}`, pageWidth - 38, pageHeight - 28, { align: "right" });
    }

    return pdf.output("blob");
  } finally {
    document.body.removeChild(container);
  }
}

/* ============================================================
   CSV REPORT
   ============================================================ */

export function generateCSVReport(
  childInfo: ChildInfo,
  answers: Record<string, number>,
  backendResult: BackendResult | null,
  fallbackResult: ScreeningResult | null,
) {
  const questions = getAllQuestionsFlat();
  const riskLevel = getRiskLevel(backendResult, fallbackResult);

  const rows: string[][] = [
    ["Developmental & Behavioural Screening Report"],
    ["Child", childInfo.name],
    ["Age", ageLabel(childInfo.ageMonths)],
    ["Sex", genderLabel(childInfo.gender)],
    ["Screening date", dateLabel(backendResult?.screening_date)],
    ["Screening result", resultMessage(riskLevel).title],
    [],
    ["Item", "Area", "Observation", "Response", "Screening flag"],
  ];

  Object.entries(answers).forEach(([id, index]) => {
    const q = questions[id];
    if (!q) return;

    const flag = backendResult
      ? (backendResult.domain_scores?.some((d) => d.flag_items?.includes(id)) ?? false)
      : questionFlag(q, index);

    rows.push([
      id,
      q.domain,
      OBSERVATION_LABELS[id] ?? q.text,
      q.options[index] ?? "Response recorded",
      flag ? "Flagged" : "Not flagged",
    ]);
  });

  rows.push(
    [],
    ["Disclaimer", "This report is for screening purposes only and does not constitute a medical diagnosis."],
  );

  const csv = rows
    .map((row) => row.map((cell) => `"${String(cell).replace(/"/g, '""')}"`).join(","))
    .join("\n");

  const blob = new Blob([csv], { type: "text/csv;charset=utf-8;" });
  const url = URL.createObjectURL(blob);

  const a = document.createElement("a");
  a.href = url;
  a.download = `ASD_Screening_${childInfo.name.replace(/\s+/g, "-") || "report"}-${Date.now()}.csv`;
  a.click();

  URL.revokeObjectURL(url);
}