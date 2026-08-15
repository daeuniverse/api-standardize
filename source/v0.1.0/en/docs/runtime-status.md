---
title: Runtime
---

# GET /api/runtime

> Draft endpoint. This read-only snapshot describes the running process, active
> configuration generation, eBPF datapath summary, and traffic visible to the
> engine. Detailed eBPF state is available from [`GET /api/datapath`](datapath.html),
> and the independently pollable memory snapshot is available from
> [`GET /api/runtime/memory`](runtime-memory.html).

Runtime values are observations, not a promise that the engine can see every
packet on the host. A value that is unsupported or not observable is `null`;
zero remains a valid measured value.

## Request

```http
GET /api/runtime?detail=full HTTP/1.1
Host: localhost:9527
```

`detail=summary` is the default and omits `process.pid`. `detail=full` includes
it when the adapter can observe it.

## Response

### Success (200 OK)

```json
{
  "observed_at": "2026-08-15T10:00:00Z",
  "lifecycle": {
    "state": "running",
    "started_at": "2026-08-15T08:00:00Z",
    "uptime_seconds": 7200
  },
  "generation": {
    "active_id": "generation-42",
    "config_revision": "17",
    "state": "active",
    "activated_at": "2026-08-15T09:30:00Z"
  },
  "datapath": {
    "kind": "ebpf",
    "state": "active",
    "visibility": "partial",
    "ebpf": {
      "backend": "real",
      "programs": "loaded",
      "hooks": "attached",
      "routing": {
        "state": "published",
        "generation_id": "generation-42"
      },
      "health": "healthy",
      "last_error": null,
      "checked_at": "2026-08-15T10:00:00Z"
    }
  },
  "traffic": {
    "scope": "visible",
    "observed_by": "mixed",
    "counter_since": "2026-08-15T08:00:00Z",
    "connections": {
      "tcp": 42,
      "udp": 128,
      "total": 170
    },
    "bytes": {
      "upload": 123456789,
      "download": 987654321
    },
    "rates": {
      "window_seconds": 1,
      "upload_bytes_per_second": 4096,
      "download_bytes_per_second": 32768
    }
  },
  "process": {
    "pid": 1234,
    "cpu_percent": null
  },
  "last_reload": {
    "operation_id": "op-01HZX4K8W7",
    "status": "succeeded",
    "finished_at": "2026-08-15T09:30:00Z",
    "error": null
  }
}
```

### Fields

| Field | Type | Description |
|-------|------|-------------|
| observed_at | string | Snapshot timestamp (RFC3339). |
| lifecycle.state | string | `starting`, `running`, `reloading`, `suspended`, `draining`, `degraded`, or `failed`. |
| lifecycle.started_at | string | Process start time, when known. |
| lifecycle.uptime_seconds | uint64 or null | Process uptime. |
| generation.active_id | string | Opaque active runtime generation. |
| generation.config_revision | string or null | Configuration revision used by the active generation. |
| generation.state | string | `active` or `reloading`. A pending generation is not active. |
| datapath.kind | string | `ebpf`, `userspace`, `mock`, or `unknown`. |
| datapath.state | string | `active`, `degraded`, `detached`, `failed`, `disabled`, or `unknown`. |
| datapath.visibility | string | `full`, `partial`, or `none` for traffic visible to the datapath. |
| datapath.ebpf | object or null | eBPF state summary when the datapath uses eBPF. |
| traffic.scope | string | Scope of the counters, normally `visible`. |
| traffic.observed_by | string | `userspace`, `ebpf`, or `mixed`. |
| traffic.counter_since | string or null | Start time of the reported cumulative counters. |
| traffic.connections | object | Currently visible TCP and UDP connections or sessions. |
| traffic.bytes | object | Cumulative visible bytes. |
| traffic.rates | object or null | Current rates. `null` when the engine cannot provide them. |
| process.pid | uint32 or null, optional | Engine process ID with `detail=full`. |
| process.cpu_percent | number or null | Process CPU usage when available. |
| last_reload | object or null | Most recent reload operation and its result. |

The `datapath.ebpf` summary uses these states:

| Field | Values | Meaning |
|-------|--------|---------|
| backend | `real`, `mock`, `unknown` | Backend used by the engine. |
| programs | `loaded`, `not_loaded`, `error`, `unknown` | Whether eBPF programs are loaded. |
| hooks | `attached`, `partially_attached`, `detached`, `unknown` | Whether required hooks are mounted. |
| routing.state | `published`, `not_published`, `error`, `unknown` | Whether routing is visible to eBPF. |
| routing.generation_id | string or null | Generation currently published to eBPF. |
| health | `healthy`, `degraded`, `failed`, `unknown` | Combined operational result. |

`datapath.state` may be `active` only when the required programs, hooks, and
active routing publication are all valid. A loaded program alone is not an
active datapath.

> **Note:** Per-connection details and byte counters are available from
> [`GET /api/connections`](connections.html). They carry the same visibility limits.

Memory metrics are intentionally excluded from this snapshot so a dashboard
can poll [`GET /api/runtime/memory`](runtime-memory.html) without repeatedly fetching
generation, datapath, traffic, and reload state.

During reload, the old active generation remains reported until the new
generation has passed configuration validation and datapath publication. A
failed reload therefore leaves `generation.active_id` unchanged and is exposed
through `last_reload`.

## Example

```bash
curl "http://localhost:9527/api/runtime?detail=full"
```
