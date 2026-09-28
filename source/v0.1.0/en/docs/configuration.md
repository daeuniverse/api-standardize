---
title: Configuration
---

# Configuration

The native API exposes accepted configuration sources, dry-run validation, and
single-source replacement followed by reload. Source replacement accepts a
complete engine-native text of one source, not a partial patch or a
multi-source write.

## GET /api/v1/config

Requires `observe` and `capabilities.resources.config.available`. Returns the
accepted configuration, not a fresh read of sources that may have changed in the store.
Sources, diagnostics, `generation_id`, and `revision` belong to one coherent
snapshot. The source set is complete, not silently truncated to `max_sources`.

### Request

{% api_request getConfig %}

### Success (200 OK)

{% api_example getConfig 200 redacted %}

The all-zero SHA-256 in this example is a placeholder, not a digest of a real
configuration.

### Fields

`generation_id` identifies the accepted runtime generation. `revision` is the
opaque configuration revision used by runtime and group responses; it is not
the source-write precondition.

Each source has an opaque `id` and an accepted-byte `content_sha256`. Hashes,
sizes, line counts, and diagnostic positions describe the original accepted
source before redaction. Use the source hash, not `revision`, in a replacement
request's `If-Match`.

### Visibility

Every source carries `content`, the accepted text with listener-secret values
masked; `secrets_redacted` says whether anything was masked. Source text, paths
and diagnostics follow the [visibility table](api-config.html#Visibility): only
listener-secret values are masked, in every endpoint and detail tier.
Diagnostic messages must not quote source excerpts or raw engine errors. Hashes, byte
counts, line counts, and positions describe the accepted source before redaction;
they need not match displayed text. Redacted text is not an editing representation.
Never save it over the source.

## GET /api/v1/config/sources/{source_id}

Requires `observe` and `resources.config.available`. Returns one source's
identity and content (`ConfigSourceContent`) under the same visibility rules as
`GET /config`. It reads the accepted snapshot, not the store's current contents.
The body leaves out `writable` and `loaded_at`, which can change while the bytes
stay the same; read them from `GET /config`. An unknown ID returns
`404 resource_not_found`; unavailable readback returns
`404 capability_not_supported`.

{% api_request getConfigSource %}

{% api_example getConfigSource 200 editable %}

To use returned text for editing, first verify that its UTF-8 SHA-256 equals `content_sha256`. A mismatch
means the text is not the complete accepted source. Do not save redacted text.

## Editing

`PUT /api/v1/config/sources/{source_id}` replaces one accepted source. It requires
`control`, `resources.config.available`, `resources.config.writable`, and
`writable: true` on that source. The server-wide switch does not make every
source writable. Includes and subscriptions written by the engine, including
`kind: generated` and `kind: subscription`, are read-only.

### Editor flow

1. Read `GET /config` and retain the source ID and `content_sha256`. Load the
   full text from that snapshot or the single-source GET. If content is absent
   or its digest differs, obtain the complete source through an authorized
   channel; never replace it with redacted text.
2. Edit the complete engine-native text.
3. Optionally call `POST /config/validate` in `full` mode with the resulting
   source set, if the engine advertises that mode. The server repeats the same checks
   before storing; a successful dry run does not bypass them or pin the store's state.
4. PUT `{content: string}` as `application/json`, with the retained SHA-256
   enclosed in double quotes in `If-Match`. This precondition uses source bytes,
   not the top-level configuration `revision`.
5. Poll the operation at `Location`, respecting the positive `Retry-After`
   polling floor, until it succeeds or fails. A `202` means the server accepted
   the replacement and queued its activation, not that the new configuration is
   active. A failed operation reports whether the replacement was stored and
   whether it became active; see [activation outcomes](errors.html#Activation-outcomes).
6. After successful reload, refetch `GET /config` for the accepted generation and
   `content_sha256`. If reload publishes a new generation and events are available,
   `generation.changed` announces it; the event does not waive the polling floor.

### Request

{% api_example replaceConfigSource request replacement http %}

The body accepts only `content`. It replaces the full file as UTF-8 text, including
its final newline if supplied. Empty text is a validation candidate, not a
malformed request. `resources.config.max_bytes` limits replacement UTF-8 bytes;
`limits.max_json_body_bytes` independently limits the encoded JSON body.
`max_bytes` is at most the body limit minus the request envelope: the compact
UTF-8 JSON overhead of the body, including for creation a path of the longest
allowed length. Content that JSON escaping expands can still exceed the body
limit, and that limit then applies. Exceeding either returns
`413 request_too_large`.

`GET /config/sources/{source_id}` returns the quoted `content_sha256` in `ETag`
when its content is complete. A body with a masked listener-secret value has no
`ETag`: it is not the representation that `PUT` replaces.
`If-Match` is evaluated as [conditional requests](errors.html#Conditional-requests)
defines. The optional `Idempotency-Key` follows the
[replay rules](operations.html#Replay); a replay returns the original operation
without another write or hash check.

### Validation and commit

The configuration store holds the authoritative copy of every source: files for
a file-backed engine, records for a database-backed one. For a new write, the
server checks `If-Match` against the content hash of the source in the store,
then validates the resulting source set in `full` mode with the replacement
substituted for the selected source. The check includes syntax, semantics, and
dependencies, using authorized local files and cached data only. The dependency
rules are the same as for [dry-run validation](#POST-api-v1-config-validate), including
the unfetched-subscription warning. Validation performs no network access or cache refresh.

If diagnostics contain any `error`, the server stores nothing and starts no
reload. It returns `422 unsupported_value` in the shared `{error, request_id}`
envelope, with `ConfigDiagnostic` entries in `error.details.diagnostics`.
Warnings and info alone do not prevent a write.

The server refuses the following changes before storing anything:

- A replacement that sets or changes API listener settings or secrets returns
  `403 permission_denied`.
- A requested change that cannot take effect through a reload, compared with
  the active configuration, returns `422 unsupported_value` with one
  `restart-required` error diagnostic per setting. Dry-run validation reports
  the same settings as `restart-required` warnings, because the candidate
  itself is valid.

After validation, the server commits the replacement atomically, either before
activation or after the new generation becomes active: store readers see the
old bytes or the new bytes, never a mix. Concurrent API writes serialize the
hash check, validation, and commit. The server then starts a reload operation with `kind: reload`; on failure,
`written` reports whether the store holds the replacement. The operation
succeeds only after both the commit and the activation finish; a `202` means
the server accepted the replacement, not that it is stored.

A file store commits by writing a temporary file in the source's directory and
renaming it over the source, preserving the file mode.

Each write activates the candidate it validated. The next configuration write
waits until the previous activation finishes; a server that does not queue
writes returns `409 state_conflict` instead. An edit made after the commit is
not part of this activation; it takes effect at a later reload.

The stored source can change before the commit if it is edited outside the
API. At commit the server evaluates the request's `If-Match` again against the
stored hash. If the condition no longer matches, the commit fails
with `412 stale_revision`. If the stored hash changed but the condition still
matches, as `*` or a list containing the new hash does, the commit fails with
`409 state_conflict`, because the validated candidate is stale. Either way the
replacement is not stored.

{% api_example replaceConfigSource 202 queued http %}

On reload failure, use `written` and `committed` as defined in
[activation outcomes](errors.html#Activation-outcomes). If `committed: false`,
readback still describes the previously accepted bytes. Reconcile any stored
replacement before retrying.

### Errors

| Status and code | Meaning and action |
|-----------------|--------------------|
| `403 permission_denied` | Missing `control`, disabled server-wide editing, a read-only source, a replacement that sets or changes API listener settings or secrets, or, in a file store, a source path that is no longer a regular file. Do not offer writes for that source. |
| `404 resource_not_found` | Unknown source ID. Refetch the accepted source set. |
| `409 state_conflict` | Another configuration write is still activating and this server does not queue writes, or the stored source changed before the commit while `If-Match` still matched it; nothing is stored. Retry after the write finishes, or reconcile the changed source. |
| `412 stale_revision` | `If-Match` does not match the stored content hash, on arrival or [at commit](#Validation-and-commit); the server stores nothing. Reconcile the changed source before retrying. Refetching the accepted snapshot alone may still return the old hash. |
| `422 unsupported_value` | Full validation found error diagnostics, including `restart-required`; the server stores nothing and starts no reload. Display diagnostics and correct the candidate. |
| `428 precondition_required` | `If-Match` is missing; the server writes nothing. Supply the retained source hash. |

{% api_example replaceConfigSource 422 invalid %}

The editable GET example hashes to
`d1f62f00c6da9ec33956e66b8cc3b4670f164556fc12453193904af23451dec1`.
The PUT replacement hashes to
`92fe71cacbc73458f2da2a62363cec2e1cfae3ee0e3838acd7a90562e64f242a`.
Both include the final newline. After successful reload of that replacement,
the source's accepted hash becomes the latter.

## Creating a source

`POST /api/v1/config/sources` adds one new source file and reloads. It requires
`control`, `resources.config.available`, `resources.config.writable`, and
`resources.config.create`. `create` is false by default and is true only when
`writable` is true. Without it, the request returns
`404 capability_not_supported`.

### Request

{% api_example createConfigSource request include http %}

| Field | Type | Description |
|-------|------|-------------|
| path | string | New file path relative to the main source's directory, in the same form as `ConfigSource.path`. |
| content | string | Complete UTF-8 engine-native text; empty text is a validation candidate, not a malformed request. |

`path` uses only normal segments: no leading `/`, no empty, `.`, or `..`
segment. It ends in `.dae`, has at most 1024 UTF-8 bytes, and contains no
control characters. The server resolves it inside the configuration root and
returns `400 invalid_request` for a malformed path or one whose parent resolves
outside the root, including through a symlink. Creation returns
`409 state_conflict` for a `path` already in use, by a file or an accepted
source, before it validates the content; it never overwrites.

The same content limits as for [replacement](#Editing) apply, and so does the
optional `Idempotency-Key`.

### Validation and write

The server validates the resulting source set in `full` mode, with the new file
added at `path`, under the same dependency rules as a replacement. The file must
be loaded by an include pattern of that source set, for example
`include { config.d/*.dae }` in the main source for `config.d/proxies.dae`. If
no pattern matches, validation reports a `source-not-included` error diagnostic
on the main source. Any error diagnostic returns `422 unsupported_value` with
`error.details.diagnostics`; the server creates nothing and starts no reload.
The listener-settings and `restart-required` refusals of
[replacement](#Validation-and-commit) apply as well.

{% api_example createConfigSource 422 not_included %}

Otherwise the server commits the new source to the store without replacing
anything that appeared at `path` meanwhile, and starts a reload operation with
`kind: reload`. A file store writes a temporary file in the target directory
and renames it into place with a rename that fails if `path` exists, using the
main source's file mode. Storing, activation and serialization follow the
[replacement](#Validation-and-commit) rules.

{% api_example createConfigSource 202 queued http %}

A failure before the source is stored creates nothing. After it is stored, the
[activation outcome](errors.html#Activation-outcomes) decides whether it stays:

- `committed: false`: the reload could not start or the engine rejected the new
  configuration, and the previous generation is still active. If the store
  still holds the source this operation created, with the same identity and
  the same content, the server removes it, so the store again matches the
  active configuration, and reports `written: false`. A file store compares
  both file identity and file content, so a file that replaced the created one
  at `path`, or an edit made to it in place, is never removed. If the source
  was replaced or modified, or the removal fails, the server keeps it and
  reports the cleanup conflict as `written: true` with `committed: false`: the
  source is in the store and the next reload loads it, but it is not an
  accepted source, so the API cannot address it. Reconcile it in the
  configuration store outside the API before retrying.
- `committed: true`: the new generation is active but degraded. The source
  stays and is an accepted source.
- `committed: null`: the source stays. Read `GET /config` and `GET /runtime`
  back to learn whether it became active.

After a successful reload, `GET /config` lists the new source
with `path` as given, and it can be edited through
`PUT /config/sources/{source_id}`. Replacement never removes a source: a
replaced source keeps its accepted ID, so a later PUT can repair it.

### Errors

| Status and code | Meaning and action |
|-----------------|--------------------|
| `400 invalid_request` | Malformed body or path, or a path outside the configuration root. Correct the path. |
| `403 permission_denied` | Missing `control`, disabled server-wide editing, or content that sets or changes API listener settings or secrets. |
| `404 capability_not_supported` | Readback or source creation is unavailable. Do not offer creation. |
| `409 state_conflict` | A file or accepted source already has this path; the server writes nothing. Edit that source instead or choose another path. |
| `413 request_too_large` | Content exceeds `max_bytes` or the JSON body limit. |
| `415 unsupported_media_type` | The body is not `application/json`. |
| `422 unsupported_value` | Error diagnostics, including `source-not-included`; the server writes nothing and starts no reload. |

## POST /api/v1/config/validate

Requires `control` and `capabilities.resources.config_validate.available` because
the body may contain secrets. Validation never writes files, refreshes caches,
applies configuration, publishes a generation, or starts an operation.

### Request

{% api_example validateConfig request syntax_error http %}

| Field | Type | Description |
|-------|------|-------------|
| sources | array | Nonempty ordered candidate source set; the first source is the main source. |
| sources[].id | string, optional | Request-local diagnostic ID matching `[A-Za-z0-9._-]{1,128}`; omitted IDs become `source-N`, with a one-based array index. All effective IDs must be unique and must not contain secrets. |
| sources[].path | string, optional | Engine-native source name and include-resolution base within authorized local roots; not permission to read arbitrary files. |
| sources[].content | string | Candidate engine-native text; empty text is a candidate, not a malformed request. |
| mode | string | Required `syntax` or `full`, selected from `resources.config_validate.modes`. |

`syntax` parses only submitted text. `full` also checks semantics and resolves
dependencies from submitted sources, authorized local files, and cached data.
Submitted content takes precedence at the same resolved path. Neither mode
accesses the network.

Missing or inaccessible required local dependencies produce error diagnostics.
An unfetched subscription produces a `subscription-not-fetched` warning and does
not by itself invalidate the candidate; validation does not fetch it.

`max_bytes` bounds the sum of UTF-8 configuration source bytes, not JavaScript
string length. `max_sources` bounds the source count. Both include locally
resolved source text in `full` mode. Geodata assets do not count toward the byte
limit. The shared `limits.max_json_body_bytes` separately bounds the encoded
HTTP body. Exceeding any size or source-count limit returns
`413 request_too_large`, without truncation or partial success.

### Success (200 OK)

{% api_example validateConfig 200 invalid %}

| Field | Type | Description |
|-------|------|-------------|
| valid | boolean | True exactly when validation completed without error diagnostics; warnings and info do not invalidate the candidate. |
| diagnostics | array | Shared diagnostic shape below, with IDs referring to submitted sources. Attribute dependency failures to the referring submitted source and include/subscription location. |
| generation_id | string | Running generation captured when validation starts, for context only. |
| validated_at | string | RFC 3339 time when validation completed. |

A completed validation returns `200` even when the candidate is invalid.
`valid: true` does not guarantee that a later apply will succeed. A concurrent
reload may change the running generation; this result neither pins it for a
later apply nor changes the effective configuration or revision.

Malformed JSON, invalid request shape, or duplicate effective source IDs returns
`400 invalid_request`. An unadvertised mode returns `422 unsupported_value`.
Unavailable resources return `404 capability_not_supported`. Authentication,
permission, media-type, and rate failures use the [shared errors](errors.html).

## Diagnostic fields

Readback, dry-run validation, and rejected writes use `ConfigDiagnostic`.
Diagnostic codes are engine-defined, not members of the HTTP `ErrorCode` catalogue.

| Field | Type | Description |
|-------|------|-------------|
| level | string | `error`, `warning`, or `info`. |
| source_id | string | Source ID in the effective snapshot, validation request, or replacement's resulting source set. |
| line | integer or null | One-based source line; null when unknown. |
| column | integer or null | One-based UTF-8 byte column, not a character or UTF-16 offset; null when unknown. |
| span | object or null | `start_line`, `start_column`, `end_line`, `end_column`; one-based, start inclusive and end exclusive. End must not precede start; engines may return zero-width spans. |
| code | string | Nonempty engine-defined diagnostic code. |
| message | string | Safe operator-facing description, never raw parser output. |

Coordinates refer to the original source before redaction. When known, `line`
and `column` equal the span start. Unknown locations stay null; engines must
not invent positions from setting names.
