---
title: Errors
---

# Error responses

All native API errors use one JSON envelope:

{% api_example patchGroupConfig 412 stale_revision %}

| Field | Type | Description |
|-------|------|-------------|
| error.code | string | Stable machine-readable code. |
| error.message | string | Short safe description for an operator. |
| error.details | object or null | Optional structured details; never raw engine output. |
| request_id | string or null | Identifier for correlating server-side logs. |

## Shared status semantics

The `ErrorCode` schema in the OpenAPI document enumerates exactly the codes below
for HTTP error bodies (`ApiError`); adding one is a contract change. Errors embedded
in resources (`operation.error`, `datapath.errors`, `last_reload.error`,
`provider.last_error`) carry an engine-defined code, except the shared codes
for a failed configuration change listed under
[activation outcomes](#Activation-outcomes).

| Status | Code | Meaning |
|--------|------|---------|
| 400 | `invalid_request` | The request cannot be parsed, or a parameter or field is outside its schema: wrong type, a missing field, a field the schema does not define (JSON Patch operation objects ignore such members instead), a value outside the schema's enum, range or length, or a scalar value above a bound the capabilities advertise, such as a page `limit` above `max_page_size`. A page cursor sent with different filters or a different `limit` is also `400`. |
| 401 | `authentication_required` | Credentials are missing or invalid. |
| 401 | `invalid_credentials` | Username or password is incorrect during password login. |
| 403 | `permission_denied` | The caller lacks the required permission, or listener security policy rejects the request. |
| 404 | `resource_not_found` | The requested resource does not exist. |
| 404 | `capability_not_supported` | The running engine does not expose the resource or action. |
| 405 | `method_not_allowed` | The path exists, but not with this method ([RFC 9110 §15.5.6](https://www.rfc-editor.org/rfc/rfc9110#section-15.5.6)); the response lists the supported methods in `Allow`. An unknown path is `404`. |
| 409 | `state_conflict` | The request is supported, but the current state prevents it: a name already in use, a referenced object that is not current, a transition the current state does not allow, a configuration change while a write without `If-Match` was being admitted, or a change between validation and a conditional write's commit that its `If-Match` still matches. The same request can succeed after the state changes. |
| 409 | `idempotency_conflict` | An idempotency key was reused with a different request body. |
| 409 | `event_cursor_expired` | Event or log SSE cursor cannot be replayed; open a fresh stream and establish a new baseline. |
| 409 | `setup_required` | Password login was requested before an administrator was created. |
| 409 | `setup_already_completed` | Administrator setup was requested after an administrator was created. |
| 410 | `snapshot_expired` | A page cursor is no longer usable; restart the page walk. |
| 410 | `flow_expired` | Flow evidence was evicted/expired and a tombstone still exists. |
| 412 | `stale_revision` | `If-Match` does not match the current resource revision or stored source content hash. |
| 413 | `request_too_large` | The payload, or the fan-out the request asks for, exceeds an advertised bound: the body size, the number of operations in a group patch (`max_patch_operations`), the matching live entries a bulk close selects, including non-closable ones (`max_bulk_close`), or the targets or results of a probe or trace. |
| 415 | `unsupported_media_type` | Request `Content-Type` is unsupported. |
| 422 | `unsupported_value` | The request is well-formed and within every bound, but this engine does not support its meaning: an enum member or field the schema defines and the capabilities do not advertise, or a combination of fields or capabilities the engine does not implement. Error diagnostics from full validation of a configuration candidate are also `422`. |
| 428 | `precondition_required` | A required `If-Match` header is missing. |
| 429 | `rate_limited` | The caller exceeded a request-rate limit, or a limit on repeating the same work, such as a second probe of a target that already has one admitted. |
| 503 | `temporarily_unavailable` | A shared capacity limit is full, such as a bounded queue or the stream subscriber slots, or a required runtime component is unavailable. |
| 503 | `snapshot_unavailable` | A coherent snapshot could not be pinned or held within its memory budget; retry the read. |

Any operation can return `400` or `413` before its handler runs: request
boundary checks (target and header length, `Content-Length`, body size) apply to
every request, and a `GET` with a body is malformed.

## Choosing the status

A server checks a request in this order and returns the status of the first
check that fails:

1. Authentication, authorization and routing: `401`, `403`, `404` for an
   unknown route or an unadvertised capability, and `405` with `Allow` for a
   known path that does not support the method.
2. Request boundary: a missing required `If-Match` (`428`) or a malformed one
   (`400`), then `Content-Type` (`415`), body size (`413`), and parameter and
   body schema (`400`).
3. Idempotent replay, when the request carries `Idempotency-Key`, as
   [replay](operations.html#Replay) defines: a replay returns the original
   response and no later check runs, and `409 idempotency_conflict` and the
   full-store `503` are decided at this step.
4. Precondition: `412` when `If-Match` no longer matches.
5. Semantic validation: `422`, including error diagnostics from full
   validation of a configuration candidate.
6. Current state: `409`.

A rate limit (`429`) or full shared capacity (`503`) is reported when the
request is admitted, after the checks it passed. Three exceptions: source
creation returns `409` for a `path` already in use before it validates the
content; a configuration write decides the listener-settings `403` during
validation; and a group patch checks `Content-Type` (`415`) first and reports a
missing (`428`) or malformed (`400`) `If-Match` after the replay lookup, so a
retained replay can omit `If-Match`. The
[status table](#Shared-status-semantics) defines each status. Endpoint pages link here
instead of repeating the order; an endpoint page names only which of its own
cases fall in which row.

A rejection that depends on the current state is `409`, never `422`: `422`
depends only on the request and on what the engine supports, so a `400` or `422`
does not succeed when retried unchanged against the same configuration. A `412` or `409` may succeed after the client reads the current
state again, and a `429` or `503` may succeed after `Retry-After`.

Responses with `429` or retryable `503` include `Retry-After`. A `503` from a
write the server could not confirm, such as a group selection, may still have
taken effect; read the resource back before retrying. Error messages follow the
[visibility rule](api-config.html#Visibility).

## Conditional requests

Two resources carry a strong `ETag` that a write compares in `If-Match`:

| Read | `ETag` | Conditional write |
|------|--------|-------------------|
| `GET /config/sources/{source_id}` | the source's `content_sha256`, sent only when no listener-secret value is masked | `PUT /config/sources/{source_id}` |
| `GET /groups/{group_id}/config` | the configuration-wide `revision` | `PATCH /groups/{group_id}/config` |

The server evaluates `If-Match` as
[RFC 9110 §13.1.1](https://www.rfc-editor.org/rfc/rfc9110#section-13.1.1)
defines. `*` matches when the resource exists. A comma-separated list matches
when any strong tag in it equals the current one. A weak tag (`W/"…"`) never
matches. A header that does not match returns `412 stale_revision`; a header
that is not `*` or a list of entity tags returns `400 invalid_request`. The
server evaluates the condition again when it commits the write; a change that
the condition still matches then returns `409`, as
[validation and commit](configuration.html#Validation-and-commit) defines.

The server checks the request in the order under
[choosing the status](#Choosing-the-status): body parsing and schema checks come
before the `412` precondition. Unlike
[RFC 9110 §13.2.1](https://www.rfc-editor.org/rfc/rfc9110#section-13.2.1), this
contract validates the body before it compares `If-Match` with the current tag;
when both fail, the body error takes precedence.

## Page cursors

Every paged list (`GET /nodes`, `/providers`, `/flows`, `/dns/cache`,
`/dns/log`) takes an opaque `cursor` from the previous page's `next_cursor`. The
cursor is bound to the running instance, the endpoint and resource it pages,
the retained snapshot or record, the filters, and `limit`.

- A cursor the server no longer recognises returns `410 snapshot_expired`: its
  snapshot expired or was evicted, its record left the ring, the process
  restarted, the server never issued it, or it was issued for another endpoint
  or resource. Discard the cursor and restart the
  walk without one.
- A recognised cursor sent with different filters or a different `limit`
  returns `400 invalid_request`. To change either, restart the walk without a
  cursor.
- A server never continues a walk against a different snapshot.

An expired page cursor is `410` because the snapshot it names is gone for good,
while an expired [event or log cursor](events.html#Replay-and-recovery) is `409`
because the stream still exists and the client recovers by reopening it without
a cursor and fetching new baselines.

A list `limit` is 1–1000 unless the resource advertises a lower
`max_page_size`; a larger value returns `400 invalid_request`, not a shorter
page.

## Deleting what is not there

Closing a connection returns `404 resource_not_found` when the ID is unknown or
already gone. Deleting a node or provider by an unknown ID, or deleting DNS
cache entries by an ID or filter that matches nothing, returns `200` with
`deleted: 0`. A connection close acts on one live object and reports whether
this call closed it, while the other deletes ask for an end state, absent,
that already holds.

## Activation outcomes

Activation publishes a new runtime generation. A configuration write may be
stored before or after activation; a plain reload stores nothing. For a reload,
a source replacement or creation, a node or provider create or delete, or a
group patch that edits the configuration, an activation failure reports its
outcome in `error.details`:

| Detail | Type | Meaning |
|--------|------|---------|
| `written` | boolean | The store holds the change after the failure. A plain reload stores nothing and omits it. |
| `committed` | boolean or null | Whether the new generation is active. Present on every activation failure. |
| `active_generation_id` | string or null | Present when `committed` is `true`: the active generation, or `null` when the server cannot name it. |
| `stage` | string | Synchronous responses only: the outcome code, or an engine-defined code for a failure before activation starts. |
| `durability_confirmed` | boolean | Optional. `false` when the store holds the change but could not confirm that it survives a crash. |

- `committed: false`: the change never became active, and the previous
  generation is still active.
- `committed: true`: the new generation is active, but activation did not
  complete cleanly. The request still fails. Treat the change as applied and
  refetch the configuration and runtime.
- `committed: null`: the server cannot tell. Read `GET /runtime` back and
  compare `generation.active_id` before retrying.

`written` and `committed` are independent: storage can succeed without
activation, or activation without storage. For source-creation rollback and
recovery, see [creating a source](configuration.html#Creating-a-source).

A failed operation carries the outcome code in `error.code`. A synchronous
request returns an HTTP error, usually `503 temporarily_unavailable`, and
carries the outcome code in `error.details.stage`. An engine uses each code
below when its case applies. `supervisor_reconciliation_failed` and
`store_unavailable` apply only to an engine with a separate worker supervisor
or a store it records after activation; other engines never report them.

| Code | `committed` | Meaning |
|------|-------------|---------|
| `reload_rejected` | `false` | The engine refused the new configuration. |
| `reload_degraded` | `true` | The new generation is active, but part of the datapath did not load. |
| `supervisor_reconciliation_failed` | `true` | The new generation is active, but the engine could not bring its workers in line with it. |
| `activation_unconfirmed` | `null` | Activation started and the server lost track of it, for example because the engine stopped. |
| `store_unavailable` | `true` | The new generation is active, but the store could not record it. `written` is `false`, and a restart loads the previously stored configuration. |

A failure before activation starts, such as an unavailable engine, has
`committed: false` and may use another engine-defined code.

These outcomes are reported only by an instance that survives the failure. If
the engine process stops or restarts, queued and running operations and their
outcomes can be lost, and a new instance returns `404` for their IDs. Read
`GET /runtime` and `GET /config` from the new instance before retrying.

## Endpoint-specific recovery

- [Connection closing](connections.html#Closing) defines unfiltered-close consent,
  ownership conflicts, bulk limits, repeated synchronous DELETE behavior, and the
  counts a bulk close reports when it fails partway.
- [Providers](providers.html) defines refresh conflicts and queue limits.
- [Configuration editing](configuration.html#Editing) defines source-hash
  preconditions, validation diagnostics, and recovery after failed writes or reloads.

These operations use the existing error codes above; they do not introduce
endpoint-specific HTTP error codes.
