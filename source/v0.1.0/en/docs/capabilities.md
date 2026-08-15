---
title: Capabilities
---

# GET /api/capabilities

> Draft endpoint. This is the authoritative coarse-grained feature declaration
> for the running adapter. Resource responses may further narrow capabilities
> for an individual node or group.

## Request

```http
GET /api/capabilities HTTP/1.1
Host: localhost:9527
```

## Response

### Success (200 OK)

```json
{
  "observed_at": "2026-08-15T10:00:00Z",
  "limits": {
    "max_request_target_bytes": 4096,
    "max_header_bytes": 16384,
    "max_json_body_bytes": 65536
  },
  "resources": {
    "runtime": {
      "available": true
    },
    "runtime_memory": {
      "available": true,
      "metrics": [
        "process.rss_bytes",
        "cgroup.current_bytes",
        "cgroup.limit_bytes",
        "cgroup.events.high",
        "cgroup.events.oom",
        "cgroup.events.oom_kill"
      ]
    },
    "datapath": {
      "available": true,
      "kinds": ["ebpf"],
      "details": ["attachments", "maps"]
    },
    "nodes": {
      "available": true
    },
    "groups": {
      "available": true,
      "config_patch": true,
      "selection": true,
      "max_patch_operations": 32
    },
    "probes": {
      "available": true,
      "targets": ["node", "group"],
      "transports": ["tcp", "udp"],
      "ip_versions": ["ipv4", "ipv6"],
      "limits": {
        "max_members_per_job": 128,
        "max_results_per_job": 512,
        "max_active_jobs": 4,
        "max_queued_jobs": 16,
        "max_concurrent_per_target": 2,
        "job_timeout_ms": 30000,
        "per_principal_requests_per_minute": 60,
        "global_requests_per_minute": 240
      }
    },
    "connections": {
      "available": true
    },
    "dns_query": {
      "available": true,
      "record_types": ["A", "AAAA", "HTTPS"],
      "limits": {
        "max_types_per_request": 8,
        "query_timeout_ms": 5000,
        "max_response_bytes": 65536,
        "per_principal_requests_per_minute": 120,
        "global_requests_per_minute": 480
      }
    },
    "dns_cache": {
      "available": true,
      "read": true,
      "delete_entry": true,
      "delete_name": true,
      "flush": true,
      "entry_kinds": ["positive", "negative"]
    },
    "operations": {
      "available": true,
      "retention_seconds": 300
    },
    "reload": {
      "available": true
    },
    "suspend": {
      "available": false
    },
    "resume": {
      "available": false
    }
  }
}
```

### Rules

- Every advertised resource key contains `available`.
- Top-level `limits` apply to every native route before resource-specific work
  is dispatched.
- A resource with `available: false` may omit its remaining fields.
- Optional metrics, enum values, and operation limits are explicit arrays or
  objects; clients must not infer them from the engine version.
- Unknown resource keys and fields must be ignored by clients.
- Requesting an unavailable resource or action returns `404` with
  `capability_not_supported`.
- Per-group and per-node capabilities may be stricter than this response.
- Limits are server-advertised ceilings. Exceeding a request rate returns
  `429`; exceeding fan-out or size returns `413`; a full bounded queue returns
  `503`.

`runtime_memory.metrics` contains canonical response field paths. An
implementation must not advertise a metric that it always reports as `null`.
`dns_cache.entry_kinds` declares which positive or negative cache entries can
be read and mutated without silently hiding another cache class.

## Example

```bash
curl http://localhost:9527/api/capabilities
```
