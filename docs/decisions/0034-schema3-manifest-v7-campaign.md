# Architecture decision 0034: Combined schema-3 manifest v7 campaign

Status: Accepted

## Context

Manifest version 4 owns baseline, CPU-group, pinned-concurrent, and exact-CPU
state for one measured workload. Manifest version 5 separately owns a
controlled-load A1/B/A2 session, exact-CPU state, and an auxiliary condition
workload. A generic diagnose-style campaign needs all five diagnostic phases
under one immutable experiment identity without copying evidence between
component bundles or running two unrelated exact-CPU schedules.

## Decision

Add schema-3 bundle manifest version 7 as the combined campaign variant. It
binds one measured workload with baseline, groups, pinned-concurrent, and
isolated capabilities; one auxiliary survival-window condition workload; and
canonical manifests for baseline, CPU groups, pinned-concurrent contexts,
exact CPUs, and one focused controlled-load A1/B/A2 session.

Version 7 owns exactly these private state directories:

- `state/baseline`
- `state/groups`
- `state/pinned-concurrent`
- `state/exact-cpu`
- `state/controlled-load`

Each existing phase keeps its established manifest, envelope, complete-prefix,
and lease semantics. The combined bundle does not reinterpret or duplicate a
phase record. The auxiliary identity applies only to the controlled-load
phase; the topology-screening phases remain condition-free unless a later
manifest explicitly binds a loaded-sweep protocol.

Versions 1 through 6 retain their exact accepted shapes. Version 7 cannot be
opened without both resolved workload identities, and a changed workload,
condition, schedule, topology context, controller placement, or executable
identity fails closed before execution. Existing phase owners may advance
their v7 phase while holding the same bundle-wide exclusive lease.

The read-only schema-3 summary accepts v7 and presents all five phase views.
[ADR 0035](0035-public-diagnose-campaign-and-report.md) adds topology discovery,
phase ordering, automatic resume, and final statistical report construction.
Those derived reports do not become evidence authorities merely because the
bundle is complete.

Manifest v7 may contain the derived root files `report.json`, `report.md`, and
`report.complete.json`. The completion file binds the immutable manifest and
both report byte streams and is published last. Versions 1 through 6 reject
these names as foreign root artifacts.

## Consequences

- One bundle can represent the complete generic diagnose campaign without an
  outer component-bundle format or a duplicated exact-CPU phase.
- Existing v4 and v5 bundles remain valid and are never upgraded in place.
- Statistical reporting can keep wave, child, exact-attempt, and A/B/A session
  denominators separate while joining them through one immutable campaign.
- A condition applied during every topology phase remains explicitly out of
  scope for v7 and requires a separately bound protocol.
