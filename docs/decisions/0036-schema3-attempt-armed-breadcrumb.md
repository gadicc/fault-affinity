# Architecture decision 0036: Retain a non-evidence attempt-armed breadcrumb

Status: Accepted

## Context

Schema-3 phase stores intentionally publish complete-only envelopes. This
keeps partial, malformed, or operationally invalid work out of the evidence
prefix, but a whole-system reset can leave no durable indication that the next
scheduled unit had been entered. The contiguous prefix identifies what would
run next, not whether an owner had begun that unit. External notes or a screen
photograph may then be the only distinction.

Persisting a partial attempt as evidence would weaken the established phase
contracts. The missing fact is operational context and must remain visibly
separate from outcome evidence.

## Decision

Allow schema-3 manifest versions 1 through 7 to contain one optional private
root file, `attempt-armed.json`. This is an additive bundle-reader contract and
does not change a manifest or phase-envelope version.

While holding the bundle-wide exclusive execution lease, every phase owner:

1. resolves the exact next scheduled unit;
2. durably commits the canonical no-clobber breadcrumb before calling the phase
   runner;
3. publishes a complete phase envelope under the existing rules, when valid;
   and
4. durably removes the breadcrumb on every normal return.

The record binds version, bundle generation, phase, first arm timestamp, and a
fixed unit shape containing its ordinal plus applicable context, CPU,
controller, and child-count fields. A retry of the same interrupted unit keeps
the original timestamp. A normal operationally invalid or runner-error return
removes the marker because the command remains able to report that failure.
An unexpected throw or host reset leaves it in place.

The authoritative reader validates canonical encoding, bounds, generation,
phase, and schedule identity. A marker matching the current uncommitted unit is
classified `interrupted`. A marker matching the last committed unit is
classified `reconciled`, covering a reset after envelope publication but before
marker removal. Any other marker fails closed.

The breadcrumb is always exposed with `evidence: false`. It proves only that
the lease owner durably armed and entered its execution path. It does not prove
that a workload process launched, that the unit completed, what outcome
occurred, or that the unit caused a host failure. Complete phase envelopes
remain the sole outcome evidence.

Schema-3 summary version 1 gains additive `next` fields for incomplete phases
and an additive top-level `attemptArmed` view. Text output labels the breadcrumb
non-evidence.

## Consequences

- A bundle left by a hard reset can identify the exact unit the owner had
  entered without fabricating an outcome.
- The commit-before-removal window is distinguishable from an uncommitted
  interrupted unit.
- Existing bundles remain readable and are never upgraded in place.
- The breadcrumb deliberately cannot close the final gap between arming and
  actual child launch; stronger launch evidence would require a different,
  process-confirmed protocol.
