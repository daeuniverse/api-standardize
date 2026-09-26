---
title: Groups
---

# Groups

> Draft endpoint. A group contains direct node or group members, configuration,
> runtime selection, and typed health observations. Nested groups are kept as
> group members and must not be flattened into the primary member list.

The group API separates these responsibilities:

- `GET` reads the current group state.
- `PATCH` changes group configuration only.
- `PUT` changes runtime selection when the policy supports manual selection, or pins a member on an automatic policy that allows an override.
- `DELETE` clears such a pin so the automatic policy chooses again.
- `POST /api/v1/probes` starts a typed probe job whose target can be a group.

## Group resource

{% api_example getGroup 200 current %}

### Resource fields

| Field | Type | Description |
|-------|------|-------------|
| id | string | Opaque stable group identifier. Do not derive API identity from `name`. |
| name | string | Engine-visible group name. |
| icon | string or null | Icon the configuration names for the group (absolute http(s) URL or data URI), shown beside the name. `null` when none is configured; a client may keep its own local override. |
| config_revision | string | Revision used for optimistic configuration updates. |
| policy.kind | string | Canonical behavior: `selector`, `urltest`, `loadbalance`, `fallback`, `random`, or `score`. |
| policy.native | string | Effective engine policy, not a configuration alias that the runtime implements differently. |
| members | array | Direct group members, in declaration order. |
| members[].id | string | Opaque node or group member identifier. |
| members[].kind | string | `node` or `group`. |
| config | object | Configured group options. It is separate from runtime state. |
| runtime.selection | object | Current selection by transport. A value may be `null`. |
| runtime.health | array | Member-context observations using the shared node health dimensions and metrics. Unknown latency is null; zero is never a failure sentinel. |
| capabilities | object | Operations and fields supported by the current engine. |

`resolved_leaf_node_id` is optional. It is present when a member resolves to an
actual node, and is separate from `member_id` because a honk group can select a
nested group tag while dialing its selected leaf node.

The API must not assume that every group has one current node:

- `random` and `loadbalance` may select per connection and have no stable pick.
- URLTest may have no selection before its first usable measurement.
- TCP and UDP selections may differ.
- A selected group member may resolve to a different leaf node later.

`runtime.selection` is a coarse transport summary, not an authoritative pick
for every address family/purpose or future flow. `resolved_leaf_node_id` is an
observation, not a promise to dial that leaf. Actual per-flow selection paths
and failed/cancelled candidates belong to the recorded flow.

Group health adds nullable `sorting_latency_ms`: the actual latency used for
ranking **this member in this group**, including engine recovery penalty and
group offset. It is not defined for random/selector or non-latency Score
ranking. Nullable `ranking` describes `metric` (native metric name),
`recovery_penalty_ms`, `group_offset_ms`, `score`, and a safe `reason`.
Unknown components are null; do not reverse-engineer them from a group winner.
Health fields use [Nodes](node-latency.html)'s raw metric definitions.

`tolerance` is path-dependent switching hysteresis in whole milliseconds, not an
additive latency. `check_interval` and `idle_timeout` are whole seconds.
Nested groups, eligibility, retained choices, concurrency, and Score evidence
also influence selection. Even a complete health snapshot cannot replay a
past decision; it must not replace decision-time flow evidence. Score is a
distinct policy, not URLTest with its score mislabeled as milliseconds.

## GET /api/v1/groups

Returns group summaries for discovery, including the same opaque
`config_revision` as the detail resource; preserve it without numeric parsing.
Use the detail endpoint for members and health observations.

### Request

{% api_request listGroups %}

### Success (200 OK)

{% api_example listGroups 200 groups %}

## GET /api/v1/groups/{groupId}

Returns the complete current group resource described above.
The response includes an `ETag` whose value matches `config_revision`.

### Request

{% api_request getGroup %}

## PATCH /api/v1/groups/{groupId}

Updates group configuration only. It does not change runtime selection.

Use RFC 6902 JSON Patch and send the revision returned by `GET` in
`If-Match`.

{% api_example patchGroup request tolerance http %}

Only fields listed in `capabilities.mutable_config` may be patched. Group
membership sources are intentionally not part of this operation:
`members`, `filters`, and nested group relationships require an engine-owned
configuration reload and must not be silently changed at runtime.
More operations than `resources.groups.max_patch_operations` returns
`413 request_too_large` before any change is applied. A successful synchronous
update returns the new `ETag`; a rejected patch changes nothing.

When `check_url` is mutable, it accepts only absolute `http` or `https` URLs
without userinfo. An adapter that dials the check URL from its own host also
applies these destination rules: only default ports are allowed unless an
administrator configures an explicit port allowlist. After resolution,
loopback, link-local, multicast, unspecified, private, and cloud-metadata
destinations are rejected unless present in an administrator-owned destination
allowlist. The validated address is pinned for the connection. The adapter
reapplies these checks after every redirect and enforces bounded redirects,
response size, and timeout.

An adapter that dials check URLs through the group's member nodes instead
applies the same validation to a patched `check_url` as to the value written
through a [configuration source](configuration.html) update; the destination
rules above do not apply to that path.

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

{% api_example patchGroup 202 queued %}

## PUT /api/v1/groups/{groupId}/selection

Replaces the runtime selection when `capabilities.can_select` is `true`.
Selection is separate from configuration so a runtime choice is not confused
with the group's default member or policy.

{% api_example selectGroupMember request tcp_udp http %}

`network` is `tcp`, `udp`, or `both`. The member must be a direct member of the
group. For a nested group, `member_id` identifies the group member; the response
may also include its resolved leaf node.

An unsupported member or policy returns `422 unsupported_value`. A temporarily
invalid runtime transition returns `409 state_conflict`. Manual selection is not
emulated for an unsupported policy.

### Success (200 OK)

{% api_example selectGroupMember 200 selected %}

### Pinning a member on an automatic policy

When `capabilities.can_select` is `false` but `capabilities.can_override` is
`true`, the same request pins the member: the policy stops choosing for that
transport until the pin is cleared or the next configuration activation resets
it. The pin is runtime state, not written to the configuration. While it
stands, `runtime.selection.<transport>.source` is `override` and the response
reports `source: override`. Health checks keep running so the ranking is
current when the pin is cleared. A group with neither capability returns
`422 unsupported_value`.

## DELETE /api/v1/groups/{groupId}/selection

Clears the override for `network`, which defaults to `both`. The response contains
`selection.tcp` and `selection.udp`; either is null when that transport has no
selected member. The requested transports return to automatic selection, while
an unrequested transport may retain its override. If no override existed, the
current selection is returned unchanged. A selector group returns `409 state_conflict`.

{% api_example clearGroupOverride 200 automatic_again %}

## Group probes

Use [`POST /api/v1/probes`](check-nodes.html) with a group target. Results preserve
the requested direct `member_id` separately from the actual `resolved_leaf_node_id`.
The probe contract defines nested resolution, `direct` and `leaves` scopes,
deduplication, health effects, and failed measurements.

## Examples

```bash
curl http://localhost:9527/api/v1/groups
curl http://localhost:9527/api/v1/groups/group-proxy
```
