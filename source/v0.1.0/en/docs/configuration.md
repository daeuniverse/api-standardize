---
title: Configuration (Deferred)
---

# Configuration (Deferred)

The canonical configuration resource is intentionally deferred. This draft
does not currently define `GET /api/config` or `PATCH /api/config` because a
shared shape must preserve each engine's configuration semantics without
exposing credentials or pretending one engine's file format is universal.

The current native contract exposes only configuration-adjacent state:

- `GET /api/runtime` identifies the active generation and configuration
  revision.
- `PATCH /api/groups/{groupId}` changes only fields explicitly listed by that
  group's capabilities.
- `POST /api/operations/reload` asks the engine to load its engine-owned
  configuration.

Until a neutral resource is designed, implementations must not advertise a
native configuration resource in `GET /api/capabilities`. Existing
engine-specific or Clash-compatible configuration endpoints remain outside
this native contract.
