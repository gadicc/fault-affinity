import {
  fisherExactGreater,
  wilson,
  zeroFailureUpperBound,
} from "../../diagnose-lib/stats.mjs";
import { buildSchema3BundleSummary } from "./schema3-summary.mjs";
import { listControlledLoadRecipes } from "./controlled-load-recipes.mjs";

export const CAMPAIGN_REPORT_VERSION = 1;

const TARGET_CATEGORIES = new Set(["target-fault", "corruption"]);

export class CampaignReportError extends Error {
  constructor(message, code = "INVALID_CAMPAIGN_REPORT") {
    super(message);
    this.name = "CampaignReportError";
    this.code = code;
  }
}

function fail(message) {
  throw new CampaignReportError(message);
}

function deepFreeze(value) {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

function outcomeFromEvidence(evidence) {
  const outcome = evidence?.outcome;
  if (outcome?.validOutcome !== true || typeof outcome.category !== "string" ||
      typeof outcome.label !== "string") {
    fail("campaign evidence contains an invalid committed outcome");
  }
  return outcome;
}

function countsForEvidences(evidences) {
  let target = 0;
  let pass = 0;
  let other = 0;
  for (const evidence of evidences) {
    const category = outcomeFromEvidence(evidence).category;
    if (TARGET_CATEGORIES.has(category)) target += 1;
    else if (category === "pass") pass += 1;
    else other += 1;
  }
  return { target, pass, other };
}

function statistics({ target, pass, other }) {
  const resolved = target + pass;
  if (resolved === 0) {
    return {
      target,
      pass,
      other,
      resolved,
      rate: null,
      wilson95: null,
      zeroTargetUpper95: null,
    };
  }
  const interval = wilson(target, resolved);
  return {
    target,
    pass,
    other,
    resolved,
    rate: target / resolved,
    wilson95: { low: interval.low, high: interval.high },
    zeroTargetUpper95: target === 0 ? zeroFailureUpperBound(resolved) : null,
  };
}

function evidenceForBoundAttempt(bound) {
  return bound?.attempt?.evidence ?? bound?.evidence;
}

function childStatistics(envelopes) {
  return statistics(countsForEvidences(envelopes.flatMap((envelope) =>
    envelope.attempts.map(evidenceForBoundAttempt))));
}

function waveStatistics(envelopes) {
  const counts = { target: 0, pass: 0, other: 0 };
  for (const envelope of envelopes) {
    const childCounts = countsForEvidences(envelope.attempts.map(evidenceForBoundAttempt));
    if (childCounts.target > 0) counts.target += 1;
    else if (childCounts.other === 0 && childCounts.pass === envelope.attempts.length) {
      counts.pass += 1;
    } else {
      counts.other += 1;
    }
  }
  return statistics(counts);
}

function baselineReport(phase) {
  return {
    status: phase.progress.status,
    complete: phase.progress.complete,
    committedWaves: phase.progress.committedWaves,
    scheduledWaves: phase.progress.totalWaves,
    waves: waveStatistics(phase.envelopes),
    children: childStatistics(phase.envelopes),
  };
}

function groupReport(phase) {
  const contexts = phase.manifest.topology.contexts.map((context) => {
    const envelopes = phase.envelopes.filter((envelope) =>
      envelope.wave.contextId === context.id);
    return {
      id: context.id,
      kind: context.kind,
      cpus: [...context.cpus],
      committedWaves: envelopes.length,
      waves: waveStatistics(envelopes),
      children: childStatistics(envelopes),
    };
  });
  return {
    status: phase.progress.status,
    complete: phase.progress.complete,
    committedWaves: phase.progress.committedWaves,
    scheduledWaves: phase.progress.totalWaves,
    waves: waveStatistics(phase.envelopes),
    children: childStatistics(phase.envelopes),
    contexts,
  };
}

function pinnedReport(phase) {
  const contexts = phase.manifest.topology.contexts.map((context) => {
    const envelopes = phase.envelopes.filter((envelope) =>
      envelope.wave.contextId === context.id);
    const cpus = context.cpus.map((cpu) => {
      const evidences = envelopes.flatMap((envelope) => envelope.attempts
        .filter((bound) => bound.slot.cpu === cpu)
        .map(evidenceForBoundAttempt));
      return { cpu, attempts: statistics(countsForEvidences(evidences)) };
    });
    return {
      id: context.id,
      kind: context.kind,
      activeCpus: [...context.cpus],
      controllerCpu: context.controllerCpu,
      cluster: context.cluster,
      committedWaves: envelopes.length,
      waves: waveStatistics(envelopes),
      children: childStatistics(envelopes),
      cpus,
    };
  });
  return {
    status: phase.progress.status,
    complete: phase.progress.complete,
    committedWaves: phase.progress.committedWaves,
    scheduledWaves: phase.progress.totalWaves,
    waves: waveStatistics(phase.envelopes),
    children: childStatistics(phase.envelopes),
    contexts,
  };
}

function exactReport(phase) {
  const cpus = phase.manifest.schedule.cpus.map((cpu) => {
    const evidences = phase.envelopes
      .filter((envelope) => envelope.slot.cpu === cpu)
      .map((envelope) => envelope.attempt.evidence);
    return { cpu, attempts: statistics(countsForEvidences(evidences)) };
  });
  return {
    status: phase.progress.status,
    complete: phase.progress.complete,
    committedAttempts: phase.progress.committedAttempts,
    scheduledAttempts: phase.progress.totalAttempts,
    attempts: statistics(countsForEvidences(
      phase.envelopes.map((envelope) => envelope.attempt.evidence),
    )),
    cpus,
  };
}

function controlledLoadReport(phase) {
  const legs = phase.manifest.schedule.legs.map((scheduledLeg) => {
    const committedLeg = phase.envelope?.legs.find((leg) => leg.leg === scheduledLeg.leg);
    const evidences = committedLeg?.attempts.map((attempt) => attempt.evidence) ?? [];
    return {
      leg: scheduledLeg.leg,
      condition: scheduledLeg.condition,
      attempts: statistics(countsForEvidences(evidences)),
    };
  });
  return {
    status: phase.progress.status,
    complete: phase.progress.complete,
    targetCpu: phase.manifest.execution.targetCpu,
    workerCpus: [...phase.manifest.execution.workerCpus],
    attemptsPerLeg: phase.manifest.schedule.attemptsPerLeg,
    warmupMs: phase.manifest.schedule.warmupMs,
    recoveryMs: phase.manifest.schedule.recoveryMs,
    legs,
  };
}

function controlledLoadComparison(controlled) {
  const byLeg = new Map(controlled.legs.map((leg) => [leg.leg, leg]));
  const a1 = byLeg.get("a1")?.attempts;
  const b = byLeg.get("b")?.attempts;
  const a2 = byLeg.get("a2")?.attempts;
  if (!controlled.complete || [a1, b, a2].some((entry) => entry?.resolved === 0)) {
    return {
      eligible: false,
      method: "one-sided-fisher-exact",
      alternative: "with-load target rate is greater",
      reason: "all three legs need at least one endpoint-resolved observation",
    };
  }
  const compare = (control) => ({
    pGreater: fisherExactGreater(
      b.target,
      b.pass,
      control.target,
      control.pass,
    ),
    directional: b.rate > control.rate,
  });
  const bVsA1 = compare(a1);
  const bVsA2 = compare(a2);
  return {
    eligible: true,
    method: "one-sided-fisher-exact",
    alternative: "with-load target rate is greater",
    bVsA1,
    bVsA2,
    replicatedP: Math.max(bVsA1.pGreater, bVsA2.pGreater),
    replicatedAssociation: bVsA1.directional && bVsA2.directional &&
      bVsA1.pGreater < 0.05 && bVsA2.pGreater < 0.05,
    endpointPolicy: "pass-plus-target-only",
  };
}

export function buildCampaignReport(bundle) {
  if (bundle?.manifest?.version !== 7 || bundle.baseline === undefined ||
      bundle.groups === undefined || bundle.pinnedConcurrent === undefined ||
      bundle.exactCpu === undefined || bundle.controlledLoad === undefined) {
    fail("a campaign report requires a complete schema-3 manifest-v7 bundle shape");
  }
  const summary = buildSchema3BundleSummary(bundle);
  const phases = {
    baseline: baselineReport(bundle.baseline),
    groups: groupReport(bundle.groups),
    pinnedConcurrent: pinnedReport(bundle.pinnedConcurrent),
    exactCpu: exactReport(bundle.exactCpu),
    controlledLoad: controlledLoadReport(bundle.controlledLoad),
  };
  const complete = Object.values(phases).every((phase) => phase.complete);
  const report = {
    version: CAMPAIGN_REPORT_VERSION,
    bundle: summary.bundle,
    workload: summary.workload,
    conditionWorkload: summary.conditionWorkload,
    status: complete ? "complete" : "incomplete",
    complete,
    phases,
    comparisons: {
      controlledLoad: controlledLoadComparison(phases.controlledLoad),
    },
    interpretation: {
      targetCategories: [...TARGET_CATEGORIES],
      resolvedDenominator: "pass-plus-target-only",
      waveRule: "target if any child has a target outcome; pass only if every child passes",
      caution: "Wave, child, exact-attempt, and A/B/A denominators are distinct and are never pooled.",
    },
  };
  return deepFreeze(report);
}

function affectedAttempts(attempts) {
  return attempts?.target > 0 && attempts?.resolved > 0;
}

function candidateFromAttempts({ cpu, attempts, source, context = null, activeCpus = null }) {
  return {
    cpu,
    source,
    context,
    activeCpus: activeCpus === null ? null : [...(activeCpus ?? [])],
    target: attempts.target,
    pass: attempts.pass,
    other: attempts.other,
    resolved: attempts.resolved,
    rate: attempts.rate,
  };
}

function strongerCandidate(left, right) {
  const leftRate = BigInt(left.target) * BigInt(right.resolved);
  const rightRate = BigInt(right.target) * BigInt(left.resolved);
  if (leftRate !== rightRate) return leftRate > rightRate ? -1 : 1;
  if (left.target !== right.target) return right.target - left.target;
  if (left.resolved !== right.resolved) return right.resolved - left.resolved;
  return left.cpu - right.cpu;
}

/**
 * Return the non-pooled, endpoint-resolved target observations that can guide a
 * follow-up controlled-load run. Exact-CPU observations are deliberately kept
 * separate from pinned-concurrent observations. For pinned observations, an
 * overlapping CPU retains only its finest (smallest active-CPU set) context
 * before target observations are considered; equal-size contexts are resolved
 * by context ID.
 */
export function summarizeCampaignCandidates(report) {
  const exact = (report?.phases?.exactCpu?.cpus ?? [])
    .filter(({ attempts }) => affectedAttempts(attempts))
    .map(({ cpu, attempts }) => candidateFromAttempts({
      cpu,
      attempts,
      source: "exact",
    }))
    .sort(strongerCandidate);

  const pinnedByCpu = new Map();
  for (const context of report?.phases?.pinnedConcurrent?.contexts ?? []) {
    for (const { cpu, attempts } of context.cpus ?? []) {
      const candidate = candidateFromAttempts({
        cpu,
        attempts,
        source: "pinned",
        context: context.id,
        activeCpus: context.activeCpus,
      });
      const current = pinnedByCpu.get(cpu);
      // Do not use rate to choose between overlapping contexts: that would
      // silently privilege a coarser denominator. Equal-size contexts resolve
      // by context ID, independently of the report's traversal order.
      if (current === undefined || candidate.activeCpus.length < current.activeCpus.length ||
          (candidate.activeCpus.length === current.activeCpus.length &&
            candidate.context < current.context)) {
        pinnedByCpu.set(cpu, candidate);
      }
    }
  }
  const pinned = [...pinnedByCpu.values()]
    .filter(({ target, resolved }) => target > 0 && resolved > 0)
    .sort(strongerCandidate);
  return deepFreeze({ exact, pinned });
}

/**
 * Pick one CPU for a new experiment. Any isolated exact-CPU target evidence
 * outranks pinned evidence; pinned contexts are considered only when no exact
 * CPU has a target observation.
 */
export function selectStrongestCampaignCandidate(report) {
  const summary = summarizeCampaignCandidates(report);
  return summary.exact[0] ?? summary.pinned[0] ?? null;
}

function loadCpusForCandidate(report, candidate) {
  const exactCpus = (report?.phases?.exactCpu?.cpus ?? []).map(({ cpu }) => cpu);
  const pcores = (report?.phases?.groups?.contexts ?? [])
    .filter((context) => context.kind === "pcore")
    .flatMap((context) => context.cpus ?? []);
  const preferred = pcores.length > 0 && !pcores.includes(candidate.cpu)
    ? pcores
    : exactCpus;
  return [...new Set(preferred)].filter((cpu) => cpu !== candidate.cpu).sort((left, right) => left - right);
}

function shellQuote(value) {
  return `'${String(value).replaceAll("'", "'\"'\"'")}'`;
}

function matchingConfirmationRecipe(report, selectionSources) {
  if (selectionSources?.measured !== "built-in" ||
      selectionSources?.condition !== "built-in") return null;
  const matches = listControlledLoadRecipes().filter((recipe) =>
    recipe.measuredWorkload === report?.workload?.id &&
    recipe.conditionWorkload === report?.conditionWorkload?.id);
  return matches.length === 1 ? matches[0] : null;
}

function focusedLoadedObservation(report) {
  const phase = report?.phases?.controlledLoad;
  const attempts = phase?.legs?.find(({ leg }) => leg === "b")?.attempts;
  return attempts?.target > 0 && attempts?.resolved > 0
    ? { cpu: phase.targetCpu, attempts }
    : null;
}

/**
 * Render a compact terminal-only follow-up. This does not alter the stored
 * report or its Markdown artifact; callers provide the destination directory
 * that the dry run should validate.
 */
export function renderCampaignCandidateSummary(report, {
  outDir = "OUT_DIR",
  selectionSources,
} = {}) {
  const summary = summarizeCampaignCandidates(report);
  const candidate = summary.exact[0] ?? summary.pinned[0] ?? null;
  if (candidate === null) {
    const lines = [
      "No affected CPU candidate from isolated exact-CPU or selected finest " +
        "pinned-concurrent evidence.",
    ];
    const loaded = focusedLoadedObservation(report);
    if (loaded !== null) {
      lines.push(`Focused controlled-load observation (reported separately): CPU ${loaded.cpu} ` +
        `B leg ${loaded.attempts.target}/${loaded.attempts.resolved} = ` +
        `${percentage(loaded.attempts.rate)}.`,
      "This targeted B-leg result is not used to infer a from-scratch candidate.");
    }
    return `${lines.join("\n")}\n`;
  }
  const context = candidate.source === "exact"
    ? "isolated exact CPU evidence"
    : `pinned context ${candidate.context} (${candidate.activeCpus.join(",")})`;
  const loadCpus = loadCpusForCandidate(report, candidate);
  const lines = ["", "Affected CPU candidates:"];
  if (summary.exact.length === 0) lines.push("  isolated: none observed");
  else {
    for (const row of summary.exact) {
      lines.push(`  CPU ${row.cpu} isolated: ${row.target}/${row.resolved} = ` +
        percentage(row.rate));
    }
  }
  if (summary.pinned.length === 0) lines.push("  pinned-concurrent: none observed");
  else {
    for (const row of summary.pinned) {
      lines.push(`  CPU ${row.cpu} pinned ${row.context} [${row.activeCpus.join(",")}]: ` +
        `${row.target}/${row.resolved} = ${percentage(row.rate)}`);
    }
  }
  lines.push(`Strongest candidate: CPU ${candidate.cpu} from ${context}; ` +
    `${candidate.target}/${candidate.resolved} = ${percentage(candidate.rate)}.`);
  if (loadCpus.length === 0) {
    lines.push("No automatic A/B/A command: no separate load CPU is available.", "");
    return lines.join("\n");
  }
  const recipe = matchingConfirmationRecipe(report, selectionSources);
  if (recipe === null) {
    lines.push("No automatic A/B/A command: there is no controlled-load recipe for the " +
      `measured '${report?.workload?.id ?? "unknown"}' and condition ` +
      `'${report?.conditionWorkload?.id ?? "unknown"}' workload identities.`,
    "Repeat those same reviewed workload selections in a fresh controlled-load plan.", "");
    return lines.join("\n");
  }
  lines.push(
    "Recommended fresh A1/B/A2 confirmation:",
    `  node fault-affinity.mjs controlled-load --recipe ${recipe.id} \\`,
    `    --target-cpu ${candidate.cpu} --load-cpus ${loadCpus.join(",")} \\`,
    `    --out-dir ${shellQuote(outDir)} --dry-run`,
    "  Review the plan, then replace --dry-run with --yes.",
    "",
  );
  return lines.join("\n");
}

function percentage(value) {
  return value === null ? "—" : `${(value * 100).toFixed(1)}%`;
}

function statsText(value) {
  if (value.resolved === 0) return `0/0 resolved; other ${value.other}`;
  if (value.target === 0) {
    return `0/${value.resolved}; 95% upper < ${percentage(value.zeroTargetUpper95)}` +
      `${value.other === 0 ? "" : `; other ${value.other}`}`;
  }
  return `${value.target}/${value.resolved} = ${percentage(value.rate)} ` +
    `[${percentage(value.wilson95.low)}, ${percentage(value.wilson95.high)}]` +
    `${value.other === 0 ? "" : `; other ${value.other}`}`;
}

function esc(value) {
  return String(value).replaceAll("|", "\\|").replaceAll("\n", " ");
}

export function renderCampaignReportMarkdown(report) {
  if (report?.version !== CAMPAIGN_REPORT_VERSION) fail("campaign report version is unsupported");
  const lines = [
    "# Fault Affinity campaign report",
    "",
    `Status: **${report.status}**`,
    "",
    `- Bundle generation: \`${report.bundle.generation}\``,
    `- Manifest: schema ${report.bundle.schema}, version ${report.bundle.manifestVersion}`,
    `- Measured workload: \`${report.workload.id}\` (digest \`${report.workload.digest}\`)`,
    `- Condition workload: \`${report.conditionWorkload.id}\` ` +
      `(digest \`${report.conditionWorkload.digest}\`)`,
    "",
    "## Phase progress",
    "",
    "| Phase | Status | Committed | Scheduled |",
    "| --- | --- | ---: | ---: |",
    `| Baseline waves | ${report.phases.baseline.status} | ` +
      `${report.phases.baseline.committedWaves} | ${report.phases.baseline.scheduledWaves} |`,
    `| CPU-group waves | ${report.phases.groups.status} | ` +
      `${report.phases.groups.committedWaves} | ${report.phases.groups.scheduledWaves} |`,
    `| Pinned-concurrent waves | ${report.phases.pinnedConcurrent.status} | ` +
      `${report.phases.pinnedConcurrent.committedWaves} | ` +
      `${report.phases.pinnedConcurrent.scheduledWaves} |`,
    `| Exact-CPU attempts | ${report.phases.exactCpu.status} | ` +
      `${report.phases.exactCpu.committedAttempts} | ` +
      `${report.phases.exactCpu.scheduledAttempts} |`,
    `| Controlled-load session | ${report.phases.controlledLoad.status} | ` +
      `${report.phases.controlledLoad.complete ? 1 : 0} | 1 |`,
    "",
    "## Baseline",
    "",
    `Wave-level target observations: ${statsText(report.phases.baseline.waves)}.`,
    "",
    `Child outcomes (descriptive): ${statsText(report.phases.baseline.children)}.`,
    "",
    "## CPU groups",
    "",
    "| Context | CPUs | Wave target rate | Child target rate (descriptive) |",
    "| --- | --- | --- | --- |",
  ];
  for (const context of report.phases.groups.contexts) {
    lines.push(`| ${esc(context.id)} | ${context.cpus.join(",")} | ` +
      `${statsText(context.waves)} | ${statsText(context.children)} |`);
  }
  lines.push("", "## Pinned-concurrent contexts", "",
    "| Context | Active CPUs | Controller | Wave target rate | Child target rate |",
    "| --- | --- | ---: | --- | --- |");
  for (const context of report.phases.pinnedConcurrent.contexts) {
    lines.push(`| ${esc(context.id)} | ${context.activeCpus.join(",")} | ` +
      `${context.controllerCpu} | ${statsText(context.waves)} | ` +
      `${statsText(context.children)} |`);
  }
  lines.push("", "### Pinned per-CPU observations", "",
    "| Context | CPU | Target rate |", "| --- | ---: | --- |");
  for (const context of report.phases.pinnedConcurrent.contexts) {
    for (const cpu of context.cpus) {
      lines.push(`| ${esc(context.id)} | ${cpu.cpu} | ${statsText(cpu.attempts)} |`);
    }
  }
  lines.push("", "## Exact logical CPUs", "",
    "| CPU | Target rate |", "| ---: | --- |");
  for (const cpu of report.phases.exactCpu.cpus) {
    lines.push(`| ${cpu.cpu} | ${statsText(cpu.attempts)} |`);
  }
  lines.push("", "## Focused controlled load", "",
    `Target CPU: ${report.phases.controlledLoad.targetCpu}. Worker CPUs: ` +
      `${report.phases.controlledLoad.workerCpus.join(",")}.`, "",
    "| Leg | Condition | Target rate |", "| --- | --- | --- |");
  for (const leg of report.phases.controlledLoad.legs) {
    lines.push(`| ${leg.leg.toUpperCase()} | ${esc(leg.condition)} | ` +
      `${statsText(leg.attempts)} |`);
  }
  const comparison = report.comparisons.controlledLoad;
  lines.push("", "### Loaded A/B/A comparison", "");
  if (!comparison.eligible) {
    lines.push(`Not available: ${comparison.reason}.`);
  } else {
    lines.push(
      `One-sided Fisher exact comparisons for a greater with-load target rate: ` +
      `B vs A1 p=${comparison.bVsA1.pGreater.toExponential(2)}; ` +
      `B vs A2 p=${comparison.bVsA2.pGreater.toExponential(2)}; ` +
      `replicated gate p=${comparison.replicatedP.toExponential(2)}.`,
      "",
      comparison.replicatedAssociation
        ? "Both directional comparisons passed the prespecified p < 0.05 gate. " +
          "This supports an association in this sequential session; it does not by itself establish causality."
        : "The replicated directional gate did not pass; no load-associated increase is claimed.",
    );
  }
  lines.push("", "## Interpretation boundary", "",
    `- ${report.interpretation.caution}`,
    "- Group masks identify execution contexts, not the exact logical CPU used by a child.",
    "- Pinned and exact per-CPU rows retain their own context-specific denominators.",
    "- Zero observed target outcomes produce an upper bound, not proof of a zero rate.",
    "- The focused A/B/A order is sequential and may retain time or order confounding.",
    "- This report is derived from the validated bundle; the bundle remains the evidence authority.",
    "",
  );
  return `${lines.join("\n")}\n`;
}
