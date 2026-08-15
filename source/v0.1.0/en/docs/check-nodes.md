---
title: Probes
---

# POST /api/probes

> Draft endpoint. Probes are explicit about their target, kind, transport,
> address family, and warmth. A group target is the native group latency-test
> operation.

Starts a bounded asynchronous probe job for a node or group.

## Request

```http
POST /api/probes HTTP/1.1
Host: localhost:9527
Content-Type: application/json

{
  "target": {
    "type": "group",
    "group_id": "group-proxy"
  },
  "kind": "latency",
  "transport": ["tcp", "udp"],
  "ip_version": "any",
  "members": "direct",
  "warmth": "cold"
}
```

### Request fields

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| target.type | string | yes | `node` or `group`. |
| target.node_id | string | conditional | Required when `target.type` is `node`. |
| target.group_id | string | conditional | Required when `target.type` is `group`. |
| kind | string | yes | Probe kind. The group latency operation uses `latency`. |
| transport | string array | yes | One or more supported transports, such as `tcp` or `udp`. |
| ip_version | string | yes | `ipv4`, `ipv6`, or `any`. |
| members | string or array | no | Group targets only: `direct`, `leaves`, or explicit member IDs. Defaults to `direct`. |
| warmth | string | yes | `cold` or `warm`, describing whether an existing connection may be reused. |

For a group target, `direct` preserves direct node and nested group members.
When a nested group is tested, the result identifies both the requested member
and the resolved leaf node. `leaves` expands nested groups for diagnostics and
deduplicates the same leaf node.

`ip_version: any` expands to each IP family advertised by
`GET /api/capabilities`, producing one result per tested family. The request
cannot supply an arbitrary URL: the adapter uses the target's configured
health-check endpoint. The URL, destination, port, address pinning, redirect,
response-body, and timeout rules are the same SSRF policy defined by the group
resource.

The probe uses native policy semantics and may change an automatic selection.
The completed result reports selection side effects independently for TCP and
UDP.

## Response

### Accepted (202 Accepted)

```http
HTTP/1.1 202 Accepted
Location: /api/operations/op-01HZX4K8W9
Retry-After: 1
Content-Type: application/json
```

```json
{
  "operation_id": "op-01HZX4K8W9",
  "kind": "probe",
  "status": "queued",
  "href": "/api/operations/op-01HZX4K8W9"
}
```

Poll [`GET /api/operations/{id}`](operations.html) for completion.

### Completed result

```json
{
  "operation_id": "op-01HZX4K8W9",
  "kind": "probe",
  "status": "succeeded",
  "created_at": "2026-08-15T09:59:59Z",
  "started_at": "2026-08-15T10:00:00Z",
  "finished_at": "2026-08-15T10:00:01Z",
  "result": {
    "target": {
      "type": "group",
      "group_id": "group-proxy"
    },
    "selection_changed": {
      "tcp": true,
      "udp": false
    },
    "selection_before": {
      "tcp": "node-us-01",
      "udp": null
    },
    "selection_after": {
      "tcp": "node-hk-01",
      "udp": null
    },
    "results": [
      {
        "member_id": "node-hk-01",
        "resolved_leaf_node_id": "node-hk-01",
        "transport": "tcp",
        "ip_version": "ipv4",
        "state": "healthy",
        "latency_ms": 45,
        "error": null,
        "observed_at": "2026-08-15T10:00:00Z"
      },
      {
        "member_id": "group-jp",
        "resolved_leaf_node_id": "node-jp-01",
        "transport": "udp",
        "ip_version": "ipv4",
        "state": "unavailable",
        "latency_ms": null,
        "error": "udp_probe_timeout",
        "observed_at": "2026-08-15T10:00:00Z"
      }
    ]
  },
  "error": null
}
```

### Limits

The adapter enforces the limits advertised under `resources.probes.limits`:

- fan-out above `max_members_per_job` returns `413 request_too_large`;
- projected results above `max_results_per_job` return `413` before dispatch;
- per-target concurrency and principal/global rates return `429 rate_limited`
  with `Retry-After`;
- a full bounded queue returns `503 temporarily_unavailable` with
  `Retry-After`; and
- the complete job stops at `job_timeout_ms`, with unfinished samples reported
  as `unavailable` and `probe_deadline_exceeded`.

### Result fields

| Field | Type | Description |
|-------|------|-------------|
| result.target | object | Node or group that was tested. |
| result.selection_changed | object | Whether TCP or UDP selection changed. |
| result.selection_before | object | TCP and UDP member IDs before the probe, or `null`. |
| result.selection_after | object | TCP and UDP member IDs after the probe, or `null`. |
| result.results | array | One typed result per member, transport, and tested IP family. |
| result.results[].member_id | string | Direct group member or node targeted. |
| result.results[].resolved_leaf_node_id | string or null | Actual leaf node tested. |
| result.results[].transport | string | `tcp` or `udp`. |
| result.results[].ip_version | string | `ipv4` or `ipv6`. |
| result.results[].state | string | `healthy`, `unavailable`, or `unknown`. |
| result.results[].latency_ms | number or null | Measured latency; failure is `null`, never `0`. |
| result.results[].observed_at | string | Observation timestamp (RFC3339). |
| result.results[].error | string or null | Safe machine-readable failure code. |

## Example

```bash
curl -X POST http://localhost:9527/api/probes \
  -H 'Content-Type: application/json' \
  -d '{
    "target": {"type": "group", "group_id": "group-proxy"},
    "kind": "latency",
    "transport": ["tcp", "udp"],
    "ip_version": "any",
    "members": "direct",
    "warmth": "cold"
  }'
```
