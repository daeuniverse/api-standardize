---
title: Groups
---

# Groups

> Draft endpoint. A group contains direct node or group members, configuration,
> runtime selection, and typed health observations. Nested groups are kept as
> group members and must not be flattened into the primary member list.

The group API separates these responsibilities:

- `GET /groups/{group_id}` reads the current group state.
- `GET /groups/{group_id}/config` reads the group's policy and configured
  options with an `ETag`, and `PATCH` on the same path changes them.
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
| config_revision | string | The same underlying revision as [`GET /config`](configuration.html)'s `revision`, quoted in the `ETag` of `GET /groups/{group_id}/config`. Any accepted configuration change advances it, not only a change to this group. |
| policy.kind | string | Canonical behavior: `selector`, `urltest`, `loadbalance`, `fallback`, `random`, `score`, or `fixed`. A `fixed` group always uses its configured member, even when that member fails its check; dae's `fixed(index)` maps to it, with the index naming the member. |
| policy.native | string | Effective engine policy, not a configuration alias that the runtime implements differently. |
| members | array | Direct group members, in declaration order. |
| members[].id | string | Opaque node or group member identifier. |
| members[].kind | string | `node` or `group`. |
| config | object | The group's own configured options, separate from runtime state. For an option the engine supports, `null` means the group sets no value and the engine's inheritance and defaults apply. `interrupt_connections: null` can also mean the engine has no such option. Engine-only options go in a nested `x-<engine>` member, for example `config["x-dae"].check_addresses`; `GET` reports these members and they are not patch targets. |
| runtime.selection | object | Current selection by transport. A value may be `null`. |
| runtime.health | array | Member-context observations using the shared node health dimensions and metrics. Unknown latency is null; zero is never a failure sentinel. |
| capabilities | object | Operations and fields supported by the current engine. |

`resolved_leaf_node_id` is optional. It is present when a member resolves to an
actual node, and is separate from `member_id` because a group can select a
nested group while dialing that group's selected leaf node.

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
Health fields use [Nodes](nodes.html)'s raw metric definitions.

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

## GET /api/v1/groups/{group_id}

Returns the complete current group resource described above. The response
has no `ETag` because a tag based only on the configuration revision would not
track selection or health changes. Use `GET /groups/{group_id}/config`
for a conditional write.

### Request

{% api_request getGroup %}

## GET /api/v1/groups/{group_id}/config

Returns `{"policy": …, "config": …}`, the group's `policy` and `config` as
`GET /groups/{group_id}` reports them. The `ETag` is the configuration-wide
`config_revision` in double quotes and changes only with an accepted
configuration change.

{% api_example getGroupConfig 200 current %}

## PATCH /api/v1/groups/{group_id}/config

Updates group configuration only. It does not change runtime selection.

Use RFC 6902 JSON Patch and send the `ETag` of `GET /groups/{group_id}/config`
in `If-Match`, evaluated as [conditional requests](errors.html#Conditional-requests)
defines; a retained idempotent replay may omit it, as
[choosing the status](errors.html#Choosing-the-status) describes.
Requires `resources.groups.config_patch`; without it the request
returns `404 capability_not_supported`. A group patch is a configuration
write, so `config_patch` is true only when `resources.config.writable` is.
Because `config_revision` is configuration-wide, an unrelated accepted change
makes an older `If-Match` fail with `412`; read `GET /groups/{group_id}/config`
again and retry with its current `ETag`. At commit the server evaluates
`If-Match` again: a mismatch returns `412`, and an intervening change that
`If-Match` still matches returns `409`, as for a
[source replacement](configuration.html#Validation-and-commit).

{% api_example patchGroupConfig request tolerance http %}

Only fields listed in `capabilities.mutable_config` may be patched, judged by
the effective write: the fields whose values the patch changes, checked against
the group's policy after the patch. One patch may therefore set `policy` to
`urltest` and add `tolerance`. When the policy after the patch is not URLTest,
`tolerance` returns `422 unsupported_value` only if the patch leaves it non-null
and changed. A field the engine does not list in `mutable_config` returns
`422 unsupported_value` when the patch changes it, as for any field the schema
defines and the capabilities do not advertise; an engine without an
`interrupt_connections` option omits it from the list. Group
membership sources are intentionally not part of this operation:
`members`, `filters`, and nested group relationships require an engine-owned
configuration reload and must not be silently changed at runtime.
More operations than `resources.groups.max_patch_operations` returns
`413 request_too_large` before any change is applied. A successful synchronous
update returns the updated document and its new `ETag`; a rejected patch
changes nothing.

Mutable `check_url` values follow the
[outbound-request policy](api-config.html#Outbound-requests). A group has one
check URL. dae's `tcp_check_url` may list the URL host's addresses after the
URL; dae reports them in `config["x-dae"].check_addresses`, an
[engine extension](capabilities.html#Engine-extensions), and drops them when
a patch changes `check_url`, after which it resolves the new host itself.
dae's other check options have no shared field; dae reports them under their
own names in `config["x-dae"]`: `tcp_check_http_method` and `udp_check_dns`.

### Patch semantics

The patch target is the document `GET /groups/{group_id}/config` returns, so
paths are `/policy` and `/config/<option>`. The server applies the
operations in order, as RFC 6902 requires, to that document; the whole patch
succeeds or nothing changes. Members an operation object does not define, such
as a `comment`, are ignored ([RFC 6902 §4](https://www.rfc-editor.org/rfc/rfc6902#section-4)).

- `remove` makes the targeted property absent. Absent means the group drops
  its own value: the engine applies its inheritance and defaults, which in dae
  include the global group options such as `tcp_check_url` and
  `check_interval`. Within the same patch, `replace`, `remove` or `test` on an
  absent property, or `copy` or `move` from it, returns `400 invalid_request`,
  and `add` sets it again.
- `null` is a value, accepted only where the schema allows it. It likewise
  means the group sets no value of its own when the patch is committed.
- `copy` and `move` validate the copied value against the destination exactly
  as `add` would, including `mutable_config`.
- `test` compares against the normalized value that `GET` would report. A
  failed `test` returns `409 state_conflict`.
- After the last operation the server normalizes the result to the form `GET`
  reports and validates it as a whole, including cross-field rules such as
  `tolerance` requiring URLTest, before it commits anything.

### Responses

| Status | Meaning |
|--------|---------|
| 200 | Configuration was applied; the body is the updated configuration document and `ETag` its new revision. |
| 202 | The update was accepted and returns the shared `group_update` operation summary. |
| 412 | `If-Match` does not match the current configuration-wide `config_revision`, on arrival or at commit. |
| 404 | The group does not exist, or `resources.groups.config_patch` is false. |
| 409 | A `test` operation failed, current runtime state prevents the requested transition, or the configuration changed before the commit while `If-Match` still matched. |
| 422 | The patch is syntactically valid but the field or value is unsupported. |
| 428 | A new patch has no `If-Match`. |

An asynchronous response uses the [shared operation contract](operations.html):

{% api_example patchGroupConfig 202 queued %}

## PUT /api/v1/groups/{group_id}/selection

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

## DELETE /api/v1/groups/{group_id}/selection

Clears the override for `network`, which defaults to `both`. The response contains
`selection.tcp` and `selection.udp`; either is null when that transport has no
selected member. The requested transports return to automatic selection, while
an unrequested transport may retain its override. If no override existed, the
current selection is returned unchanged. A selector group returns `409 state_conflict`.

{% api_example clearGroupOverride 200 automatic_again %}

## Group probes

Use [`POST /api/v1/probes`](probes.html) with a group target. Results preserve
the requested direct `member_id` separately from the actual `resolved_leaf_node_id`.
The probe contract defines nested resolution, `direct` and `leaves` scopes,
deduplication, health effects, and failed measurements.

## Examples

```bash
curl http://localhost:9527/api/v1/groups
curl http://localhost:9527/api/v1/groups/group-proxy
```
