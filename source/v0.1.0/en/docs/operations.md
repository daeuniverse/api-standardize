---
title: Operations
---

# GET /api/operations/{id}

> Draft endpoint. Reload, suspend, resume, probes, and asynchronous group
> updates use one operation envelope.

An operation ID is opaque, unguessable, and unique for the lifetime of the
running adapter. Clients must not derive its kind or creation time from the ID.

## Accepted operation

An endpoint that queues work returns `202 Accepted` with `Location` and
`Retry-After` headers:

```http
HTTP/1.1 202 Accepted
Location: /api/operations/op-01HZX4K8W7
Retry-After: 1
Content-Type: application/json

{
  "operation_id": "op-01HZX4K8W7",
  "kind": "reload",
  "status": "queued",
  "href": "/api/operations/op-01HZX4K8W7"
}
```

## Request

```http
GET /api/operations/op-01HZX4K8W7 HTTP/1.1
Host: localhost:9527
```

## Response

### Running (200 OK)

```json
{
  "operation_id": "op-01HZX4K8W7",
  "kind": "reload",
  "status": "running",
  "created_at": "2026-08-15T09:29:59Z",
  "started_at": "2026-08-15T09:30:00Z",
  "finished_at": null,
  "result": null,
  "error": null
}
```

### Completed (200 OK)

```json
{
  "operation_id": "op-01HZX4K8W7",
  "kind": "reload",
  "status": "succeeded",
  "created_at": "2026-08-15T09:29:59Z",
  "started_at": "2026-08-15T09:30:00Z",
  "finished_at": "2026-08-15T09:30:01Z",
  "result": {
    "active_generation_id": "generation-42",
    "datapath_generation_id": "generation-42"
  },
  "error": null
}
```

### Fields

| Field | Type | Description |
|-------|------|-------------|
| operation_id | string | Opaque operation identifier. |
| kind | string | `probe`, `reload`, `suspend`, `resume`, or `group_update`. |
| status | string | `queued`, `running`, `succeeded`, or `failed`. |
| created_at | string | Creation timestamp (RFC3339). |
| started_at | string or null | Execution start timestamp. |
| finished_at | string or null | Terminal timestamp. |
| result | object or null | Kind-specific result, present only after success. |
| error | object or null | Safe machine-readable error after failure. |

`error` uses the same `code`, `message`, and optional `details` object defined
by the [native error contract](errors.html). Raw engine errors, stack traces,
configuration fragments, credentials, and local paths must not be returned.

Completed operations remain queryable for at least the
`resources.operations.retention_seconds` value advertised by
`GET /api/capabilities`. Unknown or expired IDs return `404 operation_not_found`.
Cancellation is not part of the current draft.

Operation status is visible to the principal that created it and to callers
with `control`; unknown, expired, or unauthorized IDs all return
`404 operation_not_found` to avoid leaking existence.

Operation-start endpoints accept an optional `Idempotency-Key` header. During
the advertised operation retention window, the key is scoped to the caller,
method, and path. Reusing it with the same body returns the original operation;
reusing it with a different body returns `409 idempotency_conflict`. Without a
key, a retried POST may create another operation.

## Example

```bash
curl http://localhost:9527/api/operations/op-01HZX4K8W7
```
