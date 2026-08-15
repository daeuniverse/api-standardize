---
title: Connections
---

# GET /api/connections

> Draft endpoint. Real-direct flows can bypass userspace, so this list is not
> necessarily a complete packet-flow inventory. Native responses label
> `observed_by` and use `null` when a counter is unavailable.

Returns a list of visible TCP and UDP connections, including per-connection
network speeds where the observation plane provides them.

## Request

```http
GET /api/connections?detail=full HTTP/1.1
Host: localhost:9527
```

## Query Parameters

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| type | string | all | Filter: `tcp`, `udp`, or `all` |
| limit | int | 100 | Max connections to return across both arrays; capped at 1000. |
| detail | string | summary | `summary` omits `src`, `dst`, and `domain`; `full` includes them when observable. |

## Response

### Success (200 OK)

```json
{
  "observed_at": "2026-08-15T10:00:00Z",
  "visibility": "partial",
  "truncated": false,
  "tcp": [
    {
      "id": "tcp-01HZX4K8W5",
      "src": "192.168.1.100:12345",
      "dst": "1.2.3.4:443",
      "domain": "example.com",
      "outbound": "proxy",
      "started_at": "2026-08-13T12:00:00Z",
      "observed_by": "userspace",
      "upload_bytes": 20480,
      "download_bytes": 1048576,
      "upload_bytes_per_second": 4096,
      "download_bytes_per_second": 32768
    }
  ],
  "udp": [
    {
      "id": "udp-01HZX4K8W6",
      "src": "192.168.1.100:5353",
      "dst": "8.8.8.8:53",
      "domain": null,
      "outbound": "direct",
      "started_at": "2026-08-13T12:00:05Z",
      "observed_by": "ebpf",
      "upload_bytes": null,
      "download_bytes": null,
      "upload_bytes_per_second": null,
      "download_bytes_per_second": null
    }
  ],
  "total_tcp": 42,
  "total_udp": 128
}
```

### Fields

| Field | Type | Description |
|-------|------|-------------|
| observed_at | string | Snapshot timestamp (RFC3339). |
| visibility | string | `full`, `partial`, or `none`. |
| truncated | bool | Whether `limit` omitted visible entries. |
| tcp | array | Active TCP connections |
| udp | array | Active UDP sessions |
| total_tcp | int | Total active TCP count |
| total_udp | int | Total active UDP count |

### Connection Object

| Field | Type | Description |
|-------|------|-------------|
| id | string | Opaque connection identifier |
| src | string, optional | Source address (ip:port), present with `detail=full` |
| dst | string, optional | Destination address (ip:port), present with `detail=full` |
| domain | string or null, optional | Sniffed domain with `detail=full`, or `null` when unknown |
| outbound | string | Outbound group name |
| started_at | string or null | Connection start time (RFC3339) when known |
| observed_by | string | `userspace`, `ebpf`, or `mixed` |
| upload_bytes | uint64 or null | Visible uploaded bytes |
| download_bytes | uint64 or null | Visible downloaded bytes |
| upload_bytes_per_second | uint64 or null | Visible upload rate |
| download_bytes_per_second | uint64 or null | Visible download rate |

> **Note:** Overall visible network speed and connection totals are available
> from [`GET /api/runtime`](runtime-status.html). The datapath may observe only a
> subset of host traffic.

When both arrays exceed `limit`, the server returns the most recently observed
entries first with a stable tie-breaker and sets `truncated: true`. Totals are
the complete counts visible at `observed_at`, not only the returned array sizes.

## Example

```bash
curl "http://localhost:9527/api/connections?type=tcp&limit=10&detail=full"
```
