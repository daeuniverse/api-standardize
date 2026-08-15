---
title: Discovery
---

# GET /api

> Draft endpoint. This resource identifies the native API surface and points to
> the bootstrap resources. Engine version information remains exclusively at
> `GET /api/version`.

## Request

```http
GET /api HTTP/1.1
Host: localhost:9527
```

## Response

### Success (200 OK)

```json
{
  "name": "dae/honk-native",
  "status": "draft",
  "links": {
    "version": "/api/version",
    "capabilities": "/api/capabilities",
    "runtime": "/api/runtime",
    "operations": "/api/operations/{id}"
  }
}
```

### Fields

| Field | Type | Description |
|-------|------|-------------|
| name | string | Stable name of the native API surface. |
| status | string | API design status; currently `draft`. |
| links | object | Stable bootstrap links. This is not a capability declaration. |

Clients use `links.version` for engine identity and `links.capabilities` to
discover which optional resources and actions the running adapter implements.
The discovery response must not copy the engine version or the
Clash-compatible `/version` payload.

## Example

```bash
curl http://localhost:9527/api
```
