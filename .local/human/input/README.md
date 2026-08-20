# human/input/

**WRITE-OWNER: human.** The authoritative, durable INPUT zone.

- `constitution.md` — amendable principles/constraints (per-file `Version` /
  `Ratified` / `Last Amended` stamp + a Governance amendment protocol).
- `requirements.md` — `REQ-<DOMAIN>-NN` entries + a Traceability matrix
  (`Unmapped: 0`) + Out-of-Scope. Shards to `requirements/<domain>.md` on
  overflow.
- `amendments/` — append-only amendment ledger (S-9 discipline): one dated
  `<YYYY-MM-DD>-<slug>.md` per change; the 引导回测 / regression lineage.

**Immutability:** a `Lifecycle: RATIFIED` requirement (or a constitution with
its `Ratified:` stamp set) is IMMUTABLE — record changes by APPENDING a dated
amendment + bumping that file's version stamp; never edit the ratified text in
place. `Lifecycle: DRAFT` blocks are freely editable until ratified.
