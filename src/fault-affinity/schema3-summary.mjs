export const SCHEMA3_SUMMARY_VERSION = 1;

function fail(message) {
  throw new TypeError(`cannot summarize schema-3 bundle: ${message}`);
}

function deepFreeze(value) {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

function workloadIdentity(value, label) {
  if (value === null || typeof value !== "object" || Array.isArray(value) ||
      !Number.isSafeInteger(value.version) || typeof value.id !== "string" ||
      typeof value.label !== "string" || typeof value.risk !== "string" ||
      typeof value.digest !== "string") {
    fail(`${label} identity is invalid`);
  }
  return {
    version: value.version,
    id: value.id,
    label: value.label,
    risk: value.risk,
    digest: value.digest,
  };
}

function outcomeRows(evidences) {
  const counts = new Map();
  for (const evidence of evidences) {
    const outcome = evidence?.outcome;
    if (outcome?.validOutcome !== true || typeof outcome.category !== "string" ||
        typeof outcome.label !== "string") {
      fail("committed attempt has invalid outcome evidence");
    }
    const key = `${outcome.category}\0${outcome.label}`;
    const current = counts.get(key);
    if (current === undefined) {
      counts.set(key, { category: outcome.category, label: outcome.label, count: 1 });
    } else {
      current.count += 1;
    }
  }
  return [...counts.values()].sort((left, right) =>
    left.category < right.category ? -1 : left.category > right.category ? 1
      : left.label < right.label ? -1 : left.label > right.label ? 1 : 0);
}

function progress(value, unit) {
  if (value === null || typeof value !== "object" || Array.isArray(value) ||
      typeof value.status !== "string" || typeof value.complete !== "boolean") {
    fail(`${unit} progress is invalid`);
  }
  const committedKey = unit === "sessions" ? "committedSessions"
    : unit === "waves" ? "committedWaves" : "committedAttempts";
  const totalKey = unit === "sessions" ? "totalSessions"
    : unit === "waves" ? "totalWaves" : "totalAttempts";
  if (!Number.isSafeInteger(value[committedKey]) || value[committedKey] < 0 ||
      !Number.isSafeInteger(value[totalKey]) || value[totalKey] < value[committedKey]) {
    fail(`${unit} progress counts are invalid`);
  }
  return {
    status: value.status,
    complete: value.complete,
    committed: value[committedKey],
    scheduled: value[totalKey],
  };
}

const DEBUGGER_OUTCOME_KINDS = new Set(["clean", "exited", "signaled", "captured", "error"]);
const ATTEMPT_ARMED_PHASES = new Set([
  "baseline-concurrent",
  "cpu-groups",
  "pinned-concurrent",
  "controlled-load-aba",
  "gdb-capture",
  "isolated-exact-cpu",
]);

function notBound() {
  return { status: "not-bound", complete: false, next: null };
}

function nextWave(value) {
  if (value == null) return null;
  return {
    ordinal: value.ordinal,
    ...(value.contextId === undefined ? {} : { contextId: value.contextId }),
    ...(value.controllerCpu === undefined ? {} : { controllerCpu: value.controllerCpu }),
    childCount: value.childCount,
  };
}

function attemptArmedSummary(value, bundleGeneration) {
  if (value === undefined) return { status: "none", evidence: false };
  const recordKeys = [
    "version", "bundleGeneration", "phase", "startedAt", "unit", "status", "evidence",
  ];
  const unitKeys = ["ordinal", "contextId", "cpu", "controllerCpu", "childCount"];
  if (value === null || typeof value !== "object" || Array.isArray(value) ||
      Object.keys(value).sort().join("\n") !== recordKeys.sort().join("\n") ||
      !["interrupted", "reconciled"].includes(value.status) || value.evidence !== false ||
      value.version !== 1 || value.bundleGeneration !== bundleGeneration ||
      !ATTEMPT_ARMED_PHASES.has(value.phase) || typeof value.startedAt !== "string" ||
      !Number.isFinite(Date.parse(value.startedAt)) ||
      new Date(value.startedAt).toISOString() !== value.startedAt || value.unit === null ||
      typeof value.unit !== "object" || Array.isArray(value.unit) ||
      Object.keys(value.unit).sort().join("\n") !== unitKeys.sort().join("\n") ||
      !Number.isSafeInteger(value.unit.ordinal) || value.unit.ordinal < 1 ||
      !(value.unit.contextId === null || typeof value.unit.contextId === "string") ||
      !["cpu", "controllerCpu"].every((key) => value.unit[key] === null ||
        (Number.isSafeInteger(value.unit[key]) && value.unit[key] >= 0)) ||
      !(value.unit.childCount === null ||
        (Number.isSafeInteger(value.unit.childCount) && value.unit.childCount >= 1))) {
    fail("attempt-armed breadcrumb is invalid");
  }
  return {
    status: value.status,
    evidence: false,
    version: value.version,
    phase: value.phase,
    startedAt: value.startedAt,
    unit: { ...value.unit },
  };
}

function exactSummary(phase) {
  if (phase === undefined) fail("exact-CPU phase is missing");
  const byCpu = new Map(phase.manifest.schedule.cpus.map((cpu) => [cpu, []]));
  const all = [];
  for (const envelope of phase.envelopes) {
    const evidence = envelope.attempt.evidence;
    const entries = byCpu.get(envelope.slot.cpu);
    if (entries === undefined) fail("exact-CPU envelope names an unscheduled CPU");
    entries.push(evidence);
    all.push(evidence);
  }
  return {
    ...progress(phase.progress, "attempts"),
    next: phase.progress.nextSlot == null ? null : {
      ordinal: phase.progress.nextSlot.ordinal,
      cpu: phase.progress.nextSlot.cpu,
    },
    outcomes: outcomeRows(all),
    cpus: [...byCpu.entries()].map(([cpu, evidences]) => ({
      cpu,
      committedAttempts: evidences.length,
      outcomes: outcomeRows(evidences),
    })),
  };
}

function baselineSummary(phase) {
  if (phase === undefined) return notBound();
  const evidences = phase.envelopes.flatMap((envelope) =>
    envelope.attempts.map((bound) => bound.attempt.evidence));
  return {
    ...progress(phase.progress, "waves"),
    next: nextWave(phase.progress.nextWave),
    committedAttempts: phase.progress.committedAttempts,
    scheduledAttempts: phase.progress.totalAttempts,
    outcomes: outcomeRows(evidences),
  };
}

function contextSummary(phase, kind) {
  if (phase === undefined) return notBound();
  const contexts = new Map(phase.manifest.topology.contexts.map((context) => [
    context.id,
    {
      id: context.id,
      kind: context.kind,
      cpus: [...context.cpus],
      ...(kind === "pinned" ? {
        cluster: context.cluster,
        controllerCpu: context.controllerCpu,
      } : {}),
      committedWaves: 0,
      committedAttempts: 0,
      evidences: [],
    },
  ]));
  for (const envelope of phase.envelopes) {
    const context = contexts.get(envelope.wave.contextId);
    if (context === undefined) fail(`${kind} envelope names an unknown context`);
    context.committedWaves += 1;
    context.committedAttempts += envelope.attempts.length;
    for (const bound of envelope.attempts) context.evidences.push(bound.attempt.evidence);
  }
  const evidences = [...contexts.values()].flatMap((context) => context.evidences);
  return {
    ...progress(phase.progress, "waves"),
    next: nextWave(phase.progress.nextWave),
    committedAttempts: phase.progress.committedAttempts,
    scheduledAttempts: phase.progress.totalAttempts,
    outcomes: outcomeRows(evidences),
    contexts: [...contexts.values()].map((context) => ({
      id: context.id,
      kind: context.kind,
      cpus: context.cpus,
      ...(kind === "pinned" ? {
        cluster: context.cluster,
        controllerCpu: context.controllerCpu,
      } : {}),
      committedWaves: context.committedWaves,
      committedAttempts: context.committedAttempts,
      outcomes: outcomeRows(context.evidences),
    })),
  };
}

function controlledLoadSummary(phase) {
  if (phase === undefined) return notBound();
  const legs = phase.envelope === null
    ? phase.manifest.schedule.legs.map((leg) => ({
      leg: leg.leg,
      condition: leg.condition,
      committedAttempts: 0,
      outcomes: [],
    }))
    : phase.envelope.legs.map((leg) => ({
      leg: leg.leg,
      condition: leg.condition,
      committedAttempts: leg.attempts.length,
      outcomes: outcomeRows(leg.attempts.map((bound) => bound.evidence)),
    }));
  return {
    ...progress(phase.progress, "sessions"),
    next: phase.progress.complete ? null : {
      ordinal: 1,
      targetCpu: phase.manifest.execution.targetCpu,
    },
    targetCpu: phase.manifest.execution.targetCpu,
    workerCpus: [...phase.manifest.execution.workerCpus],
    attemptsPerLeg: phase.manifest.schedule.attemptsPerLeg,
    warmupMs: phase.manifest.schedule.warmupMs,
    recoveryMs: phase.manifest.schedule.recoveryMs,
    legs,
  };
}

function debuggerSummary(phase) {
  if (phase === undefined) return notBound();
  const value = phase.progress;
  if (value === null || typeof value !== "object" || Array.isArray(value) ||
      typeof value.status !== "string" || typeof value.complete !== "boolean" ||
      !Number.isSafeInteger(value.committedRuns) || value.committedRuns < 0 ||
      !Number.isSafeInteger(value.maxRuns) || value.maxRuns < value.committedRuns ||
      !Number.isSafeInteger(value.capturedRuns) || value.capturedRuns < 0 ||
      !Number.isSafeInteger(value.maxCaptures) || value.maxCaptures < value.capturedRuns ||
      value.capturedRuns > value.committedRuns) {
    fail("debugger progress is invalid");
  }
  const complete = value.committedRuns === value.maxRuns ||
    value.capturedRuns >= value.maxCaptures;
  const status = value.committedRuns === 0 && !complete ? "empty"
    : complete ? "complete" : "incomplete";
  if (value.complete !== complete || value.status !== status) {
    fail("debugger progress does not reconcile");
  }
  // Per-run detail is reconciled from the committed envelopes, never from
  // the progress counters alone.
  if (!Array.isArray(phase.attempts)) fail("debugger attempts are invalid");
  const runs = phase.attempts.map((attempt, index) => {
    if (attempt === null || typeof attempt !== "object" || Array.isArray(attempt) ||
        !Number.isSafeInteger(attempt.run) || attempt.run !== index + 1 ||
        attempt.envelope === null || typeof attempt.envelope !== "object" ||
        attempt.envelope.run !== attempt.run) {
      fail("debugger attempt list is invalid");
    }
    const outcome = attempt.envelope.outcome;
    if (outcome === null || typeof outcome !== "object" || Array.isArray(outcome) ||
        !DEBUGGER_OUTCOME_KINDS.has(outcome.kind)) {
      fail("debugger attempt outcome is invalid");
    }
    const stem = `state/debugger/debugger-attempt-${String(attempt.run).padStart(9, "0")}`;
    return {
      run: attempt.run,
      outcome,
      artifacts: {
        transcript: `${stem}-transcript`,
        control: `${stem}-control`,
      },
    };
  });
  if (runs.length !== value.committedRuns ||
      runs.filter((run) => run.outcome.kind === "captured").length !== value.capturedRuns) {
    fail("debugger committed envelopes do not reconcile with progress");
  }
  const counts = new Map();
  for (const run of runs) {
    counts.set(run.outcome.kind, (counts.get(run.outcome.kind) ?? 0) + 1);
  }
  const outcomes = [...counts.entries()]
    .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
    .map(([kind, count]) => ({ kind, count }));
  return {
    status: value.status,
    complete: value.complete,
    committed: value.committedRuns,
    scheduled: value.maxRuns,
    captured: value.capturedRuns,
    maxCaptures: value.maxCaptures,
    next: complete ? null : {
      run: value.nextRun ?? value.committedRuns + 1,
      cpu: phase.manifest?.schedule?.cpu ?? null,
    },
    outcomes,
    runs,
  };
}

export function buildSchema3BundleSummary(bundle) {
  if (bundle === null || typeof bundle !== "object" || Array.isArray(bundle) ||
      bundle.manifest === null || typeof bundle.manifest !== "object") {
    fail("bundle is invalid");
  }
  const version = bundle.manifest.version;
  if (!Number.isSafeInteger(version) || version < 1 || version > 7) {
    fail("manifest version is unsupported");
  }
  if (version === 6 && bundle.debugger === undefined) {
    fail("manifest version 6 bundle is missing its debugger phase");
  }
  const summary = {
    version: SCHEMA3_SUMMARY_VERSION,
    bundle: {
      schema: 3,
      manifestVersion: version,
      generation: bundle.manifest.bundleGeneration,
      manifestBinding: { ...bundle.manifestBinding },
    },
    workload: workloadIdentity(bundle.manifest.workload, "measured workload"),
    attemptArmed: attemptArmedSummary(
      bundle.attemptArmed,
      bundle.manifest.bundleGeneration,
    ),
    ...([5, 7].includes(version) ? {
      conditionWorkload: workloadIdentity(
        bundle.manifest.auxiliaryWorkload,
        "condition workload",
      ),
    } : {}),
    phases: {
      baseline: baselineSummary(bundle.baseline),
      groups: contextSummary(bundle.groups, "group"),
      pinnedConcurrent: contextSummary(bundle.pinnedConcurrent, "pinned"),
      controlledLoad: controlledLoadSummary(bundle.controlledLoad),
      debugger: version === 6 ? debuggerSummary(bundle.debugger) : notBound(),
      exactCpu: exactSummary(bundle.exactCpu),
    },
    interpretation: {
      boundary: "validated-observations-only",
      note: "Outcome counts describe committed workload observations and do not by themselves establish a causal mechanism.",
    },
  };
  return deepFreeze(summary);
}

function outcomesText(rows) {
  return rows.length === 0
    ? "none"
    : rows.map((row) => `${row.category}/${row.label}:${row.count}`).join(", ");
}

function progressText(phase, unit) {
  if (phase.status === "not-bound") return "not bound";
  return `${phase.status}; ${phase.committed}/${phase.scheduled} ${unit}`;
}

function scheduledUnitText(value) {
  if (value === null) return "";
  const ordinal = value.run === undefined ? value.ordinal : value.run;
  const parts = [`${value.run === undefined ? "unit" : "run"}=${ordinal}`];
  if (value.contextId !== undefined && value.contextId !== null) {
    parts.push(`context=${value.contextId}`);
  }
  if (value.cpu !== undefined && value.cpu !== null) parts.push(`cpu=${value.cpu}`);
  if (value.targetCpu !== undefined) parts.push(`target-cpu=${value.targetCpu}`);
  if (value.controllerCpu !== undefined && value.controllerCpu !== null) {
    parts.push(`controller=${value.controllerCpu}`);
  }
  if (value.childCount !== undefined && value.childCount !== null) {
    parts.push(`children=${value.childCount}`);
  }
  return parts.join(" ");
}

function nextText(phase) {
  return phase.next === null ? "" : `; next ${scheduledUnitText(phase.next)}`;
}

export function renderSchema3BundleSummary(summary) {
  if (summary?.version !== SCHEMA3_SUMMARY_VERSION) fail("summary version is unsupported");
  const lines = [
    "Fault Affinity schema-3 evidence summary",
    `bundle: manifest v${summary.bundle.manifestVersion}; generation ${summary.bundle.generation}`,
    `workload: ${summary.workload.id}; risk ${summary.workload.risk}; digest ${summary.workload.digest}`,
  ];
  if (summary.conditionWorkload !== undefined) {
    lines.push(`condition workload: ${summary.conditionWorkload.id}; ` +
      `risk ${summary.conditionWorkload.risk}; digest ${summary.conditionWorkload.digest}`);
  }
  if (summary.attemptArmed.status !== "none") {
    lines.push(`attempt armed: ${summary.attemptArmed.status}; ` +
      `phase=${summary.attemptArmed.phase} ${scheduledUnitText(summary.attemptArmed.unit)}; ` +
      `started=${summary.attemptArmed.startedAt}; non-evidence breadcrumb`);
  }
  const { baseline, groups, pinnedConcurrent, controlledLoad, exactCpu } = summary.phases;
  const debuggerPhase = summary.phases.debugger;
  lines.push(`baseline: ${progressText(baseline, "waves")}` +
    `${baseline.outcomes === undefined ? "" : `; outcomes ${outcomesText(baseline.outcomes)}`}` +
    nextText(baseline));
  lines.push(`groups: ${progressText(groups, "waves")}` +
    `${groups.outcomes === undefined ? "" : `; outcomes ${outcomesText(groups.outcomes)}`}` +
    nextText(groups));
  for (const context of groups.contexts ?? []) {
    lines.push(`  context ${context.id} cpus=${context.cpus.join(",")} ` +
      `waves=${context.committedWaves} attempts=${context.committedAttempts}; ` +
      `outcomes ${outcomesText(context.outcomes)}`);
  }
  lines.push(`pinned-concurrent: ${progressText(pinnedConcurrent, "waves")}` +
    `${pinnedConcurrent.outcomes === undefined
      ? "" : `; outcomes ${outcomesText(pinnedConcurrent.outcomes)}`}` +
    nextText(pinnedConcurrent));
  for (const context of pinnedConcurrent.contexts ?? []) {
    lines.push(`  context ${context.id} controller=${context.controllerCpu} ` +
      `cpus=${context.cpus.join(",")} waves=${context.committedWaves} ` +
      `attempts=${context.committedAttempts}; outcomes ${outcomesText(context.outcomes)}`);
  }
  lines.push(`controlled-load: ${progressText(controlledLoad, "sessions")}` +
    nextText(controlledLoad));
  for (const leg of controlledLoad.legs ?? []) {
    lines.push(`  leg ${leg.leg} condition=${leg.condition} attempts=${leg.committedAttempts}; ` +
      `outcomes ${outcomesText(leg.outcomes)}`);
  }
  lines.push(`debugger: ${progressText(debuggerPhase, "runs")}` +
    `${debuggerPhase.status === "not-bound"
      ? "" : `; captured ${debuggerPhase.captured}/${debuggerPhase.maxCaptures}`}` +
    nextText(debuggerPhase));
  for (const run of debuggerPhase.runs ?? []) {
    lines.push(`  run ${run.run}: ${run.outcome.kind}` +
      `${run.outcome.signal === undefined ? "" : ` signal=${run.outcome.signal}`}` +
      `${run.outcome.kind === "captured"
        ? ` target=${run.outcome.target ? "yes" : "no"}`
        : ""}` +
      `${run.outcome.exitCode === undefined ? "" : ` exit=${run.outcome.exitCode}`}` +
      `${run.outcome.code === undefined ? "" : ` error=${run.outcome.code}`}`);
  }
  lines.push(`exact-CPU: ${progressText(exactCpu, "attempts")}; ` +
    `outcomes ${outcomesText(exactCpu.outcomes)}` + nextText(exactCpu));
  for (const cpu of exactCpu.cpus) {
    lines.push(`  cpu ${cpu.cpu}: attempts=${cpu.committedAttempts}; ` +
      `outcomes ${outcomesText(cpu.outcomes)}`);
  }
  lines.push(`interpretation: ${summary.interpretation.note}`);
  return `${lines.join("\n")}\n`;
}
