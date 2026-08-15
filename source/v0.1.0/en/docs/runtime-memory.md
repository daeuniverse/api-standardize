---
title: Runtime Memory
---

# GET /api/runtime/memory

> Draft endpoint. This is a lightweight, read-only memory snapshot intended for
> frequent dashboard polling. It does not enumerate connections or eBPF map
> entries.

Process, cgroup, and kernel memory are different scopes. Their values must not
be added together. A value that is unsupported or not observable is `null`;
zero remains a valid measurement.

## Request

```http
GET /api/runtime/memory HTTP/1.1
Host: localhost:9527
```

Successful responses include `Cache-Control: no-store`.

## Response

### Success (200 OK)

```json
{
  "observed_at": "2026-08-15T10:00:00Z",
  "process": {
    "rss_bytes": 67108864
  },
  "cgroup": {
    "scope": "service",
    "current_bytes": 83886080,
    "limit_bytes": 536870912,
    "events": {
      "high": 0,
      "oom": 0,
      "oom_kill": 0
    }
  },
  "kernel": {
    "ebpf_bytes": null,
    "sampled_at": null
  }
}
```

### Fields

| Field | Type | Description |
|-------|------|-------------|
| observed_at | string | Snapshot timestamp (RFC3339). |
| process | object or null | Memory attributed to the engine process. |
| process.rss_bytes | uint64 or null | Resident set size reported by the operating system. |
| cgroup | object or null | Effective cgroup memory accounting when available. |
| cgroup.scope | string | `service`, `shared`, or `unknown`. |
| cgroup.current_bytes | uint64 or null | Current cgroup memory usage. |
| cgroup.limit_bytes | uint64 or null | Effective hard limit; `null` when unlimited or unknown. |
| cgroup.events | object or null | Counters from the effective cgroup memory controller. |
| cgroup.events.high | uint64 or null | Number of times the high boundary was reached. |
| cgroup.events.oom | uint64 or null | Number of observed allocation failures caused by cgroup OOM. |
| cgroup.events.oom_kill | uint64 or null | Number of processes killed by the cgroup OOM killer. |
| kernel | object or null | Kernel memory attributable to the engine when observable. |
| kernel.ebpf_bytes | uint64 or null | Memory attributable to eBPF maps and programs. |
| kernel.sampled_at | string or null | Timestamp of the cached kernel-memory sample. |

`process.rss_bytes`, `cgroup.current_bytes`, and `kernel.ebpf_bytes` have
different accounting scopes and may overlap. Clients must display them
separately.

An implementation must not walk every eBPF map entry in the request path.
Kernel memory may be sampled asynchronously and reused across requests;
`kernel.sampled_at` lets clients show that it is older than the process and
cgroup sample.

Go heap statistics, Rust allocator statistics, and the Clash-compatible
`memory` field are implementation-specific and are not canonical native fields.
Feature availability is advertised by `GET /api/capabilities`.

Clients should not poll this resource more than once per second. Servers may
return `429` with `Retry-After` when the advertised rate limit is exceeded.
The `runtime_memory.metrics` capability lists every supported metric path;
unadvertised metrics may be omitted or `null`.

## Example

```bash
curl http://localhost:9527/api/runtime/memory
```
