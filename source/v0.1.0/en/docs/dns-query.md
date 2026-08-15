---
title: DNS Query
---

# GET /api/dns/query

> Draft endpoint. Use `GET /api/dns/query`.
> Each requested record type has its own DNS status, upstream, route source,
> cache state, and elapsed time.

Performs a live DNS query through the configured DNS module for debugging.
Successful responses include `Cache-Control: no-store`.

## Request

```http
GET /api/dns/query?domain=example.com&type=A&type=AAAA&detail=full HTTP/1.1
Host: localhost:9527
```

## Query Parameters

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| domain | string | - | Domain name to query (required) |
| type | string | A | IANA record type mnemonic such as `A`, `AAAA`, `HTTPS`, `SVCB`, `SRV`, `CNAME`, `MX`, `TXT`, `NS`, `SOA`, or `PTR`; numeric types are allowed when unknown qtypes are advertised. May be specified multiple times (e.g. `&type=A&type=AAAA`) |
| upstream | string | - | Force a specific upstream defined in `dns.upstream` (e.g. `alidns`). If omitted, the upstream is chosen by `dns.routing` |
| cache_mode | string | normal | `normal` reads and writes the runtime cache; `bypass` reads from upstream and neither reads nor writes the cache |
| detail | string | summary | `summary` omits answer RDATA; `full` includes `answers`. |

## Response

### Success (200 OK)

```json
{
  "domain": "example.com",
  "cache_mode": "normal",
  "query_time": "2026-08-14T00:00:00Z",
  "results": [
    {
      "type": "A",
      "cached": false,
      "cache_entry_id": "dns-entry-01HZX4K8W5",
      "upstream": "alidns",
      "route": {
        "source": "dns.routing",
        "rule": "domain(example.com)"
      },
      "status": "NOERROR",
      "elapsed_ms": 12,
      "question": {
        "name": "example.com.",
        "type": "A"
      },
      "answers": [
        {
          "name": "example.com.",
          "type": "A",
          "class": "IN",
          "ttl": 600,
          "data": "93.184.216.34"
        }
      ]
    },
    {
      "type": "AAAA",
      "cached": false,
      "cache_entry_id": null,
      "upstream": "alidns",
      "route": {
        "source": "dns.routing",
        "rule": "domain(example.com)"
      },
      "status": "NODATA",
      "elapsed_ms": 11,
      "question": {
        "name": "example.com.",
        "type": "AAAA"
      },
      "answers": []
    }
  ]
}
```

### Fields

| Field | Type | Description |
|-------|------|-------------|
| domain | string | Query domain name |
| cache_mode | string | Cache behavior used for this query |
| query_time | string | Timestamp of the query (RFC3339) |
| results | array | One result for each requested record type. |
| results[].type | string | Requested record type. |
| results[].cached | bool | Whether this type was served from cache. |
| results[].cache_entry_id | string or null | Cache entry ID, if one exists. |
| results[].upstream | string or null | Upstream used; `null` for a cache hit. |
| results[].route.source | string | `forced`, `dns.routing`, or `default`. |
| results[].route.rule | string or null | Safe identifier or summary of the matched route. |
| results[].status | string | DNS response code such as `NOERROR`, `NXDOMAIN`, or `SERVFAIL`. |
| results[].elapsed_ms | int | Per-type elapsed time in milliseconds. |
| results[].question | object | DNS question. |
| results[].answers | array, optional | DNS answer records with `detail=full`. |

### Question Object

| Field | Type | Description |
|-------|------|-------------|
| name | string | Fully-qualified domain name |
| type | string | Record type |

### Answer Object

| Field | Type | Description |
|-------|------|-------------|
| name | string | Record name |
| type | string | Record type |
| class | string | DNS class (usually `IN`) |
| ttl | int | Time to live (seconds) |
| data | string | Record data |

### Errors and limits

A syntactically valid DNS execution returns `200` even when a per-type DNS
status is `NXDOMAIN` or `SERVFAIL`. Invalid names and types use the
[shared error envelope](errors.html). Canonical names are limited to 255 DNS
wire octets and 63 octets per label. Requested types must be unique; duplicates
return `400 invalid_request`. More types than
`resources.dns_query.limits.max_types_per_request` returns `413`. The adapter
enforces the advertised timeout, response-size, principal-rate, and global-rate
limits before dispatch; rate excess returns `429` with `Retry-After`, while an
unavailable DNS subsystem returns `503`.

## Example

```bash
curl "http://localhost:9527/api/dns/query?domain=example.com&type=A&detail=full"
curl "http://localhost:9527/api/dns/query?domain=example.com&type=A&type=AAAA"
curl "http://localhost:9527/api/dns/query?domain=example.com&upstream=googledns"
```
