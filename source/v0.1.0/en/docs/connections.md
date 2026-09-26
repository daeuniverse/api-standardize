---
title: Connections
---

# GET /api/v1/connections

> Draft endpoint. Real-direct flows can bypass userspace, so this list is not
> necessarily a complete packet-flow inventory. Native responses label
> `observed_by` and use `null` when a counter is unavailable.

Returns a list of visible TCP and UDP connections, including per-connection
network speeds where the observation plane provides them.

## Request

{% api_request listConnections %}

## Query Parameters

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| type | string | all | Filter: `tcp`, `udp`, or `all` |
| src | string | - | Exact source IP literal without a port; applied with `type` before `limit`. |
| limit | int | 100 | Max connections to return across both arrays; capped at 1000. |
| detail | string | summary | `summary` omits `src`, `dst`, and `domain`; `full` includes them when observable. |

## Response

### Success (200 OK)

{% api_example listConnections 200 visible %}

### Fields

| Field | Type | Description |
|-------|------|-------------|
| observed_at | string | Snapshot timestamp (RFC3339). |
| instance_id | string | Running adapter instance; resets on process restart. |
| visibility | string | `full`, `partial`, or `none`. |
| truncated | bool | Whether `limit` omitted visible entries matching `type` and `src`. |
| tcp | array | Active TCP connections |
| udp | array | Active UDP sessions |
| total_tcp | int | Visible active TCP count matching `type` and `src`, before `limit`. |
| total_udp | int | Visible active UDP count matching `type` and `src`, before `limit`. |

### Connection Object

| Field | Type | Description |
|-------|------|-------------|
| id | string | Opaque connection identifier |
| flow_id | string or null | Related recorded-flow ID, if correlation is known; not derived from a tuple. |
| pname | string or null | Captured process name; null without process context. Included in summary. |
| state | string | Observed lifecycle state from the flow contract, or unknown. |
| src | string, optional | Source address (ip:port), present with `detail=full` |
| dst | string, optional | Destination address (ip:port), present with `detail=full` |
| domain | string or null, optional | Sniffed domain with `detail=full`, or `null` when unknown |
| outbound | string or null | Effective routed outbound, not a leaf name masquerading as a group. |
| started_at | string or null | Actual start time if recorded; null if only post-dial registration time is known. |
| observed_by | string | `userspace`, `ebpf`, or `mixed` |
| upload_bytes | decimal uint64 string or null | Visible uploaded bytes |
| download_bytes | decimal uint64 string or null | Visible downloaded bytes |
| upload_bytes_per_second | decimal uint64 string or null | Visible upload rate, or null when the adapter does not sample per connection |
| download_bytes_per_second | decimal uint64 string or null | Visible download rate, or null when the adapter does not sample per connection |

> **Note:** Visible network speed and connection totals are available
> from [`GET /api/v1/runtime`](runtime-status.html). The datapath may observe only a
> subset of host traffic.

The per-connection rates are null when the adapter does not sample each
connection. A client may then derive a rate from two list responses with the
same top-level `instance_id` that both contain the same connection `id`:
the change in `upload_bytes` or `download_bytes` divided by the change in the
top-level `observed_at`. Skip the derivation when either byte value is null or
the later value is smaller. The result is an average over the polling interval,
and a connection seen only once has no derived rate.

When the matching entries across both arrays exceed `limit`, the server
returns the most recently observed entries first with a stable tie-breaker
and sets `truncated: true`. Totals are the complete matching counts visible
at `observed_at`, not only the returned array sizes.

Both detail tiers include the [shared list-view evidence](flows.html#List-view-fields):
`chain`, `chain_source`, `rule_id`, `rule_expression`, `rule_source`, `ingress`,
and `domain_source`. These describe the application decision, not a DNS helper's
path or today's group selection. Fetch the retained flow for the decision
timeline. All connection details require `observe`; summary is a payload-size
tier, not a privacy boundary.

The excluded transport has a total of zero. Absence from this live snapshot does
not prove a clean close; [Recorded Flows](flows.html) retains failed, blocked, and
recently terminated attempts. See [Closing](#Closing) for cancellation requirements.

The supported client/device view groups the source IP from `src` over
`detail=full` entries, ignoring the source port. This derivation is bounded
by `limit`; use the `src` filter for a per-address drill-down, not tuple
guessing or device identity inference. MAC addresses and client/device
first-seen timestamps are not on the `/connections` wire. `started_at`
describes a connection, not when the client/device was first seen.

## Example

```bash
curl "http://localhost:9527/api/v1/connections?type=tcp&limit=10&detail=full"
```

## Closing

Both DELETE endpoints require `control`. An authenticated caller without that
permission receives `403 permission_denied`. If `resources.connections.available`
or `can_close` is false, the endpoints return `404 capability_not_supported`.
Listing requires only `observe`; list availability does not imply closing support.

### What is closable

The userspace datapath must own the TCP transport or UDP session and be able
to cancel the transport or retire the session. Removing a tracker entry is
not sufficient. `observed_by` identifies the observation plane, not ownership:
`userspace` or `mixed` evidence alone does not guarantee that closing is possible.
Kernel-direct and kernel-bypassed flows (`kernel_direct` and `kernel_bypass`
scopes, including `ebpf`-only observations) are not closable. An outbound
named `direct` alone does not determine ownership.

### Single connection

`DELETE /api/v1/connections/{connection_id}` uses the opaque ID from the list,
not a tuple or a recorded-flow ID. It returns `204` only after cancellation
or retirement, with no response body or `Content-Type`. The cache and nosniff
headers remain mandatory.

{% api_request closeConnection %}

{% api_example closeConnection 204 closed http %}

An unknown or already-gone ID returns `404 resource_not_found`:

{% api_example closeConnection 404 gone %}

An observed connection that is not closable returns `409 state_conflict`:

{% api_example closeConnection 409 not_closable %}

Both DELETE endpoints accept `Idempotency-Key`, as other control calls do.
These synchronous calls evaluate current live state even with a repeated key;
they do not replay an earlier result or return a retained operation.
Closing the same ID twice therefore returns `404 resource_not_found` on
the second call, including when the key is repeated.

If cancellation or retirement cannot be confirmed, the call returns
`503 temporarily_unavailable` with `Retry-After`; the connection may already
be closed, so a retry can return `404`.

### Bulk close

`DELETE /api/v1/connections` closes every closable match and skips observed
matches that are not closable. It accepts the same `type` and exact source-IP
`src` filters as the list, combined with AND. Neither `outbound` nor `domain`
is a list filter in this revision. `limit` and `detail` affect list presentation
and are not accepted by bulk close.

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| type | string | all | Match `tcp`, `udp`, or `all`. |
| src | string | - | Match an exact source IP literal without a port. |
| all | boolean | false | Explicitly permit an unfiltered close; supplied filters still apply. |

Without `type=tcp`, `type=udp`, or `src`, the request must include `all=true`.
Missing `type` and `type=all` are both unfiltered. Otherwise, return
`400 invalid_request` before closing anything. This safety rule prevents a
missing filter from disconnecting every userspace connection.

{% api_request closeConnections %}

{% api_example closeConnections 200 closed %}

`closed` counts connections actually cancelled or retired; `skipped` counts
selected connections that were observed but not closable. Both are JSON integers
from 0 through 9007199254740991, not decimal strings. An empty match returns
`{"closed": 0, "skipped": 0}`.

Select matching live entries once, before closing. If that count, including
non-closable entries, exceeds `resources.connections.max_bulk_close`, return
`413 request_too_large` before closing any connection; do not truncate the set.
`closed + skipped` cannot exceed that limit. New arrivals are outside the selected
set; selected entries that disappear before cancellation contribute to neither count.

If closing any selected connection cannot be confirmed, return
`503 temporarily_unavailable` with `Retry-After` after every selected close has
finished. `error.details` carries the same `closed` and `skipped` counts as a
success, covering the connections handled before the failure. Those stay
closed; a retry selects again from current live state.

{% api_example closeConnections 503 incomplete %}

Unfiltered request without explicit consent:

{% api_example closeConnections 400 unfiltered %}

### Events

Closing a recorded flow advances its terminal state and emits the existing
`flow.updated` invalidation when advertised. Its `resource_id` is the flow ID,
not the connection ID; fetch `href` for the retained flow and refresh the
connection list. Changed runtime counters use `runtime.updated`. Both retain
the existing coalescing and replay rules. An unrecorded connection does not
gain a fabricated flow ID or flow event; refresh the list after success.
There is no new close event kind.
