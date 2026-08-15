---
title: Datapath
---

# GET /api/datapath

> Draft endpoint. Returns detailed datapath and eBPF state. The summary is
> also included in [`GET /api/runtime`](runtime-status.html).

The endpoint reports whether the datapath is loaded, attached, published, and
usable. `programs: loaded` alone does not mean that traffic is being handled.

## Request

```http
GET /api/datapath?detail=full HTTP/1.1
Host: localhost:9527
```

`detail=summary` is the default and omits interface names, attachments, and map
occupancy. `detail=full` includes the documented `attachments` and `maps`
objects when available.

## Response

### Success (200 OK)

```json
{
  "observed_at": "2026-08-15T10:00:00Z",
  "kind": "ebpf",
  "state": "active",
  "visibility": "partial",
  "ebpf": {
    "backend": "real",
    "programs": "loaded",
    "hooks": "attached",
    "routing": {
      "state": "published",
      "generation_id": "generation-42",
      "epoch": "3"
    },
    "attachments": [
      {
        "name": "wan_ingress",
        "interface": "eth0",
        "direction": "ingress",
        "state": "attached"
      }
    ],
    "maps": {
      "state": "ready",
      "conn_state": {
        "occupancy": 1200,
        "capacity": 524288,
        "occupancy_known": true
      }
    },
    "health": "healthy",
    "last_error": null,
    "checked_at": "2026-08-15T10:00:00Z"
  },
  "errors": []
}
```

### Fields

| Field | Type | Description |
|-------|------|-------------|
| observed_at | string | Snapshot timestamp (RFC3339). |
| kind | string | `ebpf`, `userspace`, `mock`, or `unknown`. |
| state | string | `active`, `degraded`, `detached`, `failed`, `disabled`, or `unknown`. |
| visibility | string | `full`, `partial`, or `none`. |
| ebpf.backend | string | `real`, `mock`, or `unknown`. |
| ebpf.programs | string | `loaded`, `not_loaded`, `error`, or `unknown`. |
| ebpf.hooks | string | `attached`, `partially_attached`, `detached`, or `unknown`. |
| ebpf.routing.state | string | `published`, `not_published`, `error`, or `unknown`. |
| ebpf.routing.generation_id | string or null | Generation currently published to eBPF. |
| ebpf.routing.epoch | string or null | Engine routing epoch when exposed. |
| ebpf.attachments | array | Engine-visible hook attachments. It may be empty when details are unavailable. |
| ebpf.maps.state | string | `ready`, `partial`, `error`, or `unknown`. |
| ebpf.maps.conn_state | object or null | Conntrack occupancy when the backend exposes it. |
| ebpf.health | string | `healthy`, `degraded`, `failed`, or `unknown`. |
| ebpf.last_error | string or null | Latest safe machine-readable error code. |
| ebpf.checked_at | string | Time at which eBPF state was checked. |
| errors | array | Current safe errors using `code`, `message`, and optional `details`. |

The active generation reported by `ebpf.routing.generation_id` must match
`generation.active_id` from `GET /api/runtime`. A staged or pending reload must
not be reported as active before its routing publication succeeds.

## State rules

- `active` requires loaded programs, required hooks attached, and published
  routing for the active generation.
- `degraded` means the datapath can operate only partially, or an important
  map/counter cannot be read.
- `failed` means initialization or a required runtime operation failed.
- `unknown` means the adapter cannot verify the state; it must not infer
  `active` from configuration alone.

This endpoint is read-only. Reload and lifecycle actions use
`/api/operations/*`.

## Example

```bash
curl "http://localhost:9527/api/datapath?detail=full"
```
