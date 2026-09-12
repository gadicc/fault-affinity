## Commits

- Use conventional commits with scopes for title.
- In the body, include the motivation, summary of changes, and anything else of
  note.
- At bottom: "Co-authored with <Assistant> (<model>, reasoning <level>)"
- If and only if YOU are the Codex tool, use the top-level `model` and
  `model_reasoning_effort` values from `~/.codex/config.toml` for `<model>` and
  `<level>` when present (not relevant for Antigravity or other non-Codex
  assistants).
- If the exact assistant name, model and reasoning level are unknown and cannot
  be inferred, ask the user before committing and then reuse that answer for the
  rest of the session.

## Live fault-workload safety

- Treat the current host as non-reproducing unless the user explicitly states
  otherwise for the current task. Do not assume it exhibits the historical
  case-study fault.
- Do not launch known fault triggers, stress workloads, sustained load workers,
  GDB capture campaigns, native churn experiments, or privileged
  frequency/power experiments without explicit user authorization.
- Dry runs, read-only inspection, static analysis, and harmless fixture tests
  are allowed.
- Do not modify preserved diagnostic evidence or historical result bundles.

## Preserve empirically validated triggers

- Treat a trigger, schedule, runtime pin, dependency pin, or workload identity
  that reproduced on an affected system as an immutable behavioral reference.
  Do not change it in place as part of unrelated maintenance.
- If an experiment needs different trigger behavior, add a new versioned
  workload identity and keep the empirically validated reference runnable.
- On a non-reproducing host, tests can validate harness, protocol, storage, and
  deterministic fixture behavior. They cannot establish that a modified
  trigger retains its historical reproduction rate or failure behavior.
- Any explicitly requested change to an empirically validated trigger must be
  called out as lacking affected-system reproduction validation, unless such a
  system is actually available and the user authorizes a live confirmation.
