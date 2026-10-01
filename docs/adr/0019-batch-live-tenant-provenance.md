# ADR-0019: Verify batch tenant provenance before live dispatch

**Status:** accepted · 2026-09-12
**Amends:** ADR-0011 (live command manifest provenance), ADR-0013 (execute-only access check)

The invoices batch command seals a ledgerops.batch-manifest.v2 before preview or
confirmation. Its tenantFingerprint uses the existing ledgerops.tenant.v1 digest
over the planning identity's tenantId. Profile labels and identity observation
timestamps are not organisation identity. OrganisationID is not assumed equal to
tenantId and is never used to derive this fingerprint.

Preview, --yes without --execute, and declined confirmation perform no access
lookup, create no receipt sink and dispatch nothing. After confirmation and the
existing snapshot digest check, execution authenticates one fixed client using
the snapshot's selected profile/client configuration. The authenticated profile
token independently selects its current tenant; the expected manifest never
selects a connection. Multiple connected organisations are allowed, but exactly
one connection must match that selected tenant and its fingerprint must match
the sealed fingerprint. Missing, duplicate or drifted selection refuses. It then reads
Organisation on that same tenant-bound client as an access/liveness check only.
Missing, ambiguous, malformed, mismatched or failed evidence refuses the whole
batch before sink creation or any mutation. Provider details are not emitted.

Dispatch and readback reuse that exact client; they do not resolve credentials
again or retry. The existing plan, identity freshness, Demo Company, DRAFT,
confirmation, replay and receipt policies remain unchanged. No profile substitution
or identity rebinding is performed. The existing offline identity-file profile
check still applies; tenant comparison itself ignores profile/time differences.

Historical v1 constructors, parsers, offline executor behavior and golden bytes
remain available unchanged. Live command execution requires v2 and refuses v1
evidence before lookup. The command creates v2 from its freshly planned batch;
it does not upgrade stored historical manifests. V2 fingerprints are digest-bound
provenance, not cryptographic proof that an untrusted planning file is authentic.

This adds no CLI flag or supported library API. All development and verification
use synthetic observations and clients; no live call is authorised by this record.
