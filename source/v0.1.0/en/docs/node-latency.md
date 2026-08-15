---
title: Nodes
---

# GET /api/nodes

> Draft endpoint. Returns node identity and the latest typed health samples.
> New measurements are started with `POST /api/probes`; reading this resource
> never starts network traffic.

## Request

```http
GET /api/nodes?group_id=group-proxy&limit=100 HTTP/1.1
Host: localhost:9527
```

## Query parameters

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| group_id | string | - | Return direct members of one group. |
| limit | int | 100 | Maximum nodes to return; capped at 1000. |
| cursor | string | - | Opaque cursor returned by `next_cursor`. |

## Response

### Success (200 OK)

```json
{
  "observed_at": "2026-08-15T10:00:00Z",
  "nodes": [
    {
      "id": "node-hk-01",
      "name": "hk-01",
      "protocol": "vless",
      "group_ids": ["group-proxy"],
      "health": [
        {
          "transport": "tcp",
          "ip_version": "ipv4",
          "warmth": "cold",
          "state": "healthy",
          "latency_ms": 45,
          "observed_at": "2026-08-15T10:00:00Z",
          "error": null
        }
      ]
    }
  ],
  "next_cursor": null
}
```

### Fields

| Field | Type | Description |
|-------|------|-------------|
| observed_at | string | Snapshot timestamp (RFC3339). |
| nodes | array | Nodes visible to the adapter. |
| nodes[].id | string | Opaque stable node identifier. |
| nodes[].name | string | Engine-visible node name. |
| nodes[].protocol | string or null | Protocol label when safely available. |
| nodes[].group_ids | array | Direct group memberships. |
| nodes[].health | array | Latest samples by transport, IP family, and warmth. |
| next_cursor | string or null | Cursor for the next page. |

Health `state` is `healthy`, `unavailable`, or `unknown`. Failed or unknown
latency is `null`, never `0`; `error` is a safe machine-readable code. Clients
must not derive node IDs from names.

## Example

```bash
curl "http://localhost:9527/api/nodes?group_id=group-proxy"
```
