# memory/specs/

Source-of-truth spec contracts per Architecture Rule A-4 (M-004 ADR).
Per-domain layout: `<domain>/spec.md` (e.g. `agent_workspace/spec.md`).

Mutated **only at archive time** after the change-gate composite score
PASSES per W-3 / SI-3 (>= 8.5 for minor, >= 9.0 for major). Per-change
`.local/.agent/active/<id>/spec.md` files contain DELTAS (ADDED/MODIFIED/
REMOVED Requirements) relative to this source-of-truth.
