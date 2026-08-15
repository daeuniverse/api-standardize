---
title: Suspend
---

# POST /api/operations/suspend

> Draft endpoint. Suspension is capability-gated and asynchronous. It is not
> a universal dae/honk operation.

Starts suspension for an adapter that implements a no-load lifecycle.

## Request

```http
POST /api/operations/suspend HTTP/1.1
Host: localhost:9527
Content-Type: application/json

{}
```

## Response

### Accepted (202 Accepted)

```http
HTTP/1.1 202 Accepted
Location: /api/operations/op-01HZX4K8W8
Retry-After: 1
Content-Type: application/json
```

```json
{
  "operation_id": "op-01HZX4K8W8",
  "kind": "suspend",
  "status": "queued",
  "href": "/api/operations/op-01HZX4K8W8"
}
```

Poll [`GET /api/operations/{id}`](operations.html) for completion.

### Completed result

```json
{
  "operation_id": "op-01HZX4K8W8",
  "kind": "suspend",
  "status": "succeeded",
  "created_at": "2026-08-15T10:00:59Z",
  "started_at": "2026-08-15T10:01:00Z",
  "finished_at": "2026-08-15T10:01:00Z",
  "result": {
    "runtime_state": "suspended"
  },
  "error": null
}
```

### Fields

| Field | Type | Description |
|-------|------|-------------|
| operation_id | string | Suspension operation identifier. |
| status | string | `queued`, `running`, `succeeded`, or `failed`. |
| result.runtime_state | string or null | `suspended` after a successful operation. |
| finished_at | string or null | Completion timestamp (RFC3339). |
| error | object or null | Shared safe error object, when present. |

If the adapter advertises `resources.resume.available`, resume uses:

```http
POST /api/operations/resume HTTP/1.1
Host: localhost:9527
Content-Type: application/json

{}
```

An unavailable suspend or resume operation returns `404 capability_not_supported`.
A lifecycle state that prevents the transition returns `409 state_conflict`.

## Example

```bash
curl -X POST http://localhost:9527/api/operations/suspend \
  -H 'Content-Type: application/json' \
  -d '{}'
```
