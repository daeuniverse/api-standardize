---
title: DNS Cache
---

# DNS Cache

> Draft endpoints: `GET /api/dns/cache`, `DELETE /api/dns/cache/{entry_id}`,
> filtered `DELETE /api/dns/cache`, and `POST /api/dns/cache/flush`.
> Cache introspection and mutations are independently declared under
> `resources.dns_cache` by `GET /api/capabilities`.

These endpoints operate on the engine's runtime DNS cache only. They do not
flush the kernel conntrack table, the host stub resolver, an upstream DNS
server, or any configured DNS routing rule. They also do not change
`fixed_domain_ttl`, optimistic-cache settings, or the cache size limit.

An implementation that does not expose a capability must return `404` with
`capability_not_supported`; it must not return an empty successful result.

## List entries

### `GET /api/dns/cache`

The response is a paginated snapshot. The cache can change while the client
walks the pages, so `cursor` is opaque and must not be manufactured by a
client.

```http
GET /api/dns/cache?detail=full HTTP/1.1
Host: localhost:9527
Accept: application/json
```

## Query Parameters

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| name | string | - | Exact DNS name after canonicalization; matches one question name |
| domain | string | - | Listing-only partial-match convenience filter; never accepted by a delete request |
| type | string | - | Record type filter; may be repeated, for example `type=A&type=AAAA` |
| include_expired | bool | false | Include expired entries that have not yet been lazily evicted |
| limit | int | 100 | Max entries to return; servers cap this value at 1000 |
| cursor | string | - | Opaque cursor returned as `next_cursor` |
| detail | string | summary | `summary` omits answer RDATA; `full` includes `answers`. |

## Response

### Success (200 OK)

```json
{
  "observed_at": "2026-08-15T12:00:00Z",
  "coverage": {
    "positive": true,
    "negative": true,
    "persistent": false
  },
  "entries": [
    {
      "entry_id": "dns-entry-01HZX4K8W5",
      "domain": "example.com.",
      "type": "A",
      "class": "IN",
      "status": "NOERROR",
      "answers": [
        {
          "name": "example.com.",
          "type": "A",
          "class": "IN",
          "data": "93.184.216.34",
          "ttl": 3600
        }
      ],
      "expires_at": "2026-08-15T13:00:00Z",
      "stale_until": null
    },
    {
      "entry_id": "dns-entry-01HZX4K8W6",
      "domain": "missing.example.com.",
      "type": "A",
      "class": "IN",
      "status": "NXDOMAIN",
      "answers": [],
      "expires_at": "2026-08-15T12:05:00Z",
      "stale_until": "2026-08-15T12:06:00Z"
    }
  ],
  "total": 1024,
  "next_cursor": "eyJvZmZzZXQiOjEwMH0"
}
```

### Fields

| Field | Type | Description |
|-------|------|-------------|
| observed_at | string | Snapshot timestamp (RFC3339). |
| coverage | object | Cache classes represented by this endpoint. |
| entries | array | DNS cache entries |
| total | int | Number of entries matching the filters at snapshot time |
| next_cursor | string | Opaque cursor for the next page, or `null` when complete |

`coverage.positive` and `coverage.negative` must match the advertised
`entry_kinds`. `coverage.persistent` declares whether entries outside the
runtime in-memory cache are included. Implementations must not silently omit a
cache class they claim to expose.

### Entry Object

| Field | Type | Description |
|-------|------|-------------|
| entry_id | string | Opaque runtime entry ID; not stable across restart or full flush |
| domain | string | Canonical DNS name, lower-case A-label with a trailing dot |
| type | string | Question record type, such as `A`, `AAAA`, or `HTTPS` |
| class | string | DNS question class, normally `IN` |
| status | string | `NOERROR`, `NXDOMAIN`, `NODATA`, `SERVFAIL`, or another DNS result |
| answers | array, optional | Complete cached RRset with `detail=full`; an entry is not one individual answer value |
| expires_at | string | Time at which the normal cache lifetime ends (RFC3339) |
| stale_until | string | Optional optimistic-cache stale boundary (RFC3339) |

Negative results such as `NXDOMAIN` and `NODATA` are cache entries too. A
delete operation removes the complete question/type entry, including every
answer and negative state; deleting one RDATA value from an RRset is not
supported because it would create a response that was never validated by an
upstream.

## Delete one entry

### `DELETE /api/dns/cache/{entry_id}`

Deletes exactly one cache entry identified by the opaque `entry_id` returned
by the list endpoint. The ID must be URL-encoded as a path segment.

```http
DELETE /api/dns/cache/dns-entry-01HZX4K8W5 HTTP/1.1
Host: localhost:9527
```

Deletion is idempotent and returns `200` whether the entry existed:

```json
{
  "deleted": 1
}
```

A retry after the entry is gone returns `deleted: 0`.

## Delete matching entries

### `DELETE /api/dns/cache`

Deletes all entries matching an exact name and optional record-type filters.
`name` is required for this endpoint; a partial `domain` filter is never
accepted for deletion. Omitting `type` deletes every type and both positive
and negative entries for that name.

```http
DELETE /api/dns/cache?name=example.com.&type=A&type=AAAA HTTP/1.1
Host: localhost:9527
```

The response is successful even when no entries matched, which makes retries
safe:

```json
{
  "matched": 2,
  "deleted": 2
}
```

## Flush the complete runtime cache

### `POST /api/dns/cache/flush`

Flushes all runtime DNS cache entries. This is deliberately an action endpoint
so an unfiltered `DELETE /api/dns/cache` cannot accidentally erase the entire
cache. The request body is empty or `{}`.

```http
POST /api/dns/cache/flush HTTP/1.1
Host: localhost:9527
Content-Length: 0
```

The server returns only after the invalidation barrier has been installed:

```json
{
  "matched": 1024,
  "deleted": 1024
}
```

Queries already in flight may still return their upstream result to their
caller, but a result started before the barrier must not repopulate an entry
that was flushed or deleted. A later normal DNS query may populate the cache
again.

## Mutation errors

| Status | Code | Meaning |
|--------|------|---------|
| 400 | `invalid_name` | The name is missing, malformed, or not canonicalizable |
| 400 | `filter_required` | A collection delete did not include the required exact `name` |
| 404 | `capability_not_supported` | The running engine does not expose this cache operation |
| 503 | `cache_unavailable` | The DNS cache cannot be inspected or mutated at this time |

## Example

```bash
curl "http://localhost:9527/api/dns/cache?domain=google&limit=20&detail=full"
curl -X DELETE \
  "http://localhost:9527/api/dns/cache?name=example.com.&type=A"
curl -X POST \
  "http://localhost:9527/api/dns/cache/flush"
```
