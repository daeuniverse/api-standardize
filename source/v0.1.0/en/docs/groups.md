---
title: Groups
---

# Groups

> Draft endpoint. A group contains direct node or group members, configuration,
> runtime selection, and typed health observations. Nested groups are kept as
> group members and must not be flattened into the primary member list.

The group API has four separate responsibilities:

- `GET` reads the current group state.
- `PATCH` changes group configuration only.
- `PUT` changes runtime selection when the policy supports manual selection.
- `POST /api/probes` starts a typed probe job whose target can be a group.

## Group resource

```json
{
  "id": "group-proxy",
  "name": "proxy",
  "config_revision": "17",
  "policy": {
    "kind": "urltest",
    "native": "min_moving_avg"
  },
  "members": [
    {
      "id": "node-hk-01",
      "name": "hk-01",
      "kind": "node"
    },
    {
      "id": "group-jp",
      "name": "jp",
      "kind": "group"
    }
  ],
  "config": {
    "default_member_id": null,
    "final_outbound": "direct",
    "check_url": null,
    "check_interval": 30,
    "tolerance": 50,
    "idle_timeout": null,
    "interrupt_connections": false
  },
  "runtime": {
    "selection": {
      "tcp": {
        "member_id": "node-hk-01",
        "resolved_leaf_node_id": "node-hk-01",
        "source": "health"
      },
      "udp": null
    },
    "health": [
      {
        "member_id": "node-hk-01",
        "resolved_leaf_node_id": "node-hk-01",
        "transport": "tcp",
        "ip_version": "ipv4",
        "state": "healthy",
        "latency_ms": 45,
        "observed_at": "2026-08-15T10:00:00Z"
      }
    ]
  },
  "capabilities": {
    "can_select": false,
    "supports_nested_groups": true,
    "mutable_config": [
      "policy",
      "default_member_id",
      "final_outbound",
      "check_url",
      "check_interval",
      "tolerance",
      "idle_timeout",
      "interrupt_connections"
    ],
    "probe_transports": ["tcp", "udp"]
  }
}
```

### Resource fields

| Field | Type | Description |
|-------|------|-------------|
| id | string | Opaque stable group identifier. Do not derive API identity from `name`. |
| name | string | Engine-visible group name. |
| config_revision | string | Revision used for optimistic configuration updates. |
| policy.kind | string | Canonical behavior: `selector`, `urltest`, `loadbalance`, `fallback`, or `random`. |
| policy.native | string | Engine policy, such as `fixed(0)` or `min_moving_avg`. |
| members | array | Direct group members, in declaration order. |
| members[].id | string | Opaque node or group member identifier. |
| members[].kind | string | `node` or `group`. |
| config | object | Configured group options. It is separate from runtime state. |
| runtime.selection | object | Current selection by transport. A value may be `null`. |
| runtime.health | array | Typed health observations. Unknown latency is `null`, never `0`. |
| capabilities | object | Operations and fields supported by the current engine. |

`resolved_leaf_node_id` is optional. It is present when a member resolves to an
actual node, and is separate from `member_id` because a honk group can select a
nested group tag while dialing its selected leaf node.

The API must not assume that every group has one current node:

- `random` and `loadbalance` may select per connection and have no stable pick.
- URLTest may have no selection before its first usable measurement.
- TCP and UDP selections may differ.
- A selected group member may resolve to a different leaf node later.

## GET /api/groups

Returns group summaries for discovery. Use the detail endpoint for members and
health observations.

### Request

```http
GET /api/groups HTTP/1.1
Host: localhost:9527
```

### Success (200 OK)

```json
[
  {
    "id": "group-proxy",
    "name": "proxy",
    "policy": {
      "kind": "urltest",
      "native": "min_moving_avg"
    },
    "member_count": 2,
    "selection": {
      "tcp_member_id": "node-hk-01",
      "udp_member_id": null
    }
  }
]
```

## GET /api/groups/{groupId}

Returns the complete current group resource described above.
The response includes an `ETag` whose value matches `config_revision`.

### Request

```http
GET /api/groups/group-proxy HTTP/1.1
Host: localhost:9527
```

## PATCH /api/groups/{groupId}

Updates group configuration only. It does not change runtime selection.

Use RFC 6902 JSON Patch and send the revision returned by `GET` in
`If-Match`.

```http
PATCH /api/groups/group-proxy HTTP/1.1
Host: localhost:9527
Content-Type: application/json-patch+json
If-Match: "17"

[
  {
    "op": "replace",
    "path": "/config/tolerance",
    "value": 100
  },
  {
    "op": "replace",
    "path": "/config/interrupt_connections",
    "value": true
  }
]
```

Only fields listed in `capabilities.mutable_config` may be patched. Group
membership sources are intentionally not part of this operation:
`members`, `filters`, and nested group relationships require an engine-owned
configuration reload and must not be silently changed at runtime.
More operations than `resources.groups.max_patch_operations` returns
`413 request_too_large` before any change is applied. A successful synchronous
update returns the new `ETag`; a rejected patch changes nothing.

When `check_url` is mutable, it accepts only absolute `http` or `https` URLs
without userinfo. Only default ports are allowed unless an administrator
configures an explicit port allowlist. After resolution, loopback, link-local,
multicast, unspecified, private, and cloud-metadata destinations are rejected
unless present in an administrator-owned destination allowlist. The validated
address is pinned for the connection. The adapter reapplies these checks after
every redirect and enforces bounded redirects, response size, and timeout.

### Responses

| Status | Meaning |
|--------|---------|
| 200 | Configuration was applied and the response contains the updated group. |
| 202 | The update was accepted and returns the shared `group_update` operation summary. |
| 412 | `If-Match` does not match the current `config_revision`. |
| 409 | Current runtime state prevents the requested transition. |
| 422 | The patch is syntactically valid but the field or value is unsupported. |
| 428 | Required `If-Match` is missing. |

An asynchronous response uses the [shared operation contract](operations.html):

```json
{
  "operation_id": "op-01HZX4K8WA",
  "kind": "group_update",
  "status": "queued",
  "href": "/api/operations/op-01HZX4K8WA"
}
```

## PUT /api/groups/{groupId}/selection

Replaces the runtime selection when `capabilities.can_select` is `true`.
Selection is separate from configuration so a runtime choice is not confused
with the group's default member or policy.

```http
PUT /api/groups/group-proxy/selection HTTP/1.1
Host: localhost:9527
Content-Type: application/json

{
  "member_id": "node-hk-01",
  "network": "both"
}
```

`network` is `tcp`, `udp`, or `both`. The member must be a direct member of the
group. For a nested group, `member_id` identifies the group member; the response
may also include its resolved leaf node.

Manual selection is not emulated for policies that do not support it. An
unsupported member or policy returns `422 selection_not_supported`; a
temporarily invalid runtime transition returns `409 state_conflict`.

### Success (200 OK)

```json
{
  "group_id": "group-proxy",
  "member_id": "node-hk-01",
  "resolved_leaf_node_id": "node-hk-01",
  "network": "both",
  "source": "runtime",
  "selection_revision": "8",
  "connections_interrupted": false
}
```

## Group latency tests

Use the shared `POST /api/probes` endpoint with a group target. See
[Probes](check-nodes.html) for the request and result contract.

For a group target, the probe implementation must preserve both identifiers:

- `member_id` is the direct group member requested by the caller.
- `resolved_leaf_node_id` is the actual node that was tested, when applicable.

The default member scope is `direct`. For nested groups, a direct group member
is tested through its current selected leaf, or its first resolvable leaf when
there is no current selection. `leaves` can be requested for an expanded leaf
diagnostic. Duplicate leaf nodes are measured once.

Probe results use typed state and nullable latency. A failed result is not
represented as `latency_ms: 0`.

## Examples

```bash
curl http://localhost:9527/api/groups
curl http://localhost:9527/api/groups/group-proxy
```
