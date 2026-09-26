---
title: Configuration
---

# Configuration

The native API exposes accepted configuration sources, dry-run validation, and
single-source replacement followed by reload. Source replacement accepts a
complete dae file, not a partial patch or a multi-source write.

## GET /api/v1/config

Requires `observe` and `capabilities.resources.config.available`. Returns the
accepted configuration, not a fresh read of files that may have changed on disk.
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

`capabilities.resources.config.content` is a visibility flag, false by default.
When false, every source omits `content`; it must not return an empty string as a
substitute. When true, content remains optional and must not expose secrets to
ordinary `observe` callers. Path redaction follows the existing visibility rules
in [API Configuration](api-config.html#Permissions): apply privacy filters
consistently, not only to one endpoint or detail tier. Diagnostics must not echo
source excerpts, credentials, private paths, or raw engine errors. Hashes, byte
counts, line counts, and positions describe the accepted source before redaction;
they need not match displayed text. Redacted text is not an editing representation.
Never save it over the source.

## GET /api/v1/config/sources/{source_id}

Requires `observe` and `resources.config.available`. Returns one `ConfigSource`
with the same fields and visibility rules as an entry in `GET /config`. It reads
the accepted snapshot, not current disk contents. An unknown ID returns
`404 resource_not_found`; unavailable readback returns
`404 capability_not_supported`.

{% api_request getConfigSource %}

{% api_example getConfigSource 200 editable %}

This content-bearing example assumes `resources.config.content: true`. The
default visibility setting withholds `content`. To use returned text for
editing, first verify that its UTF-8 SHA-256 equals `content_sha256`. A mismatch
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
2. Edit the complete dae text.
3. Optionally call `POST /config/validate` in `full` mode with the resulting
   source set, if the adapter advertises that mode. The server repeats the same checks
   before writing; a successful dry run does not bypass them or pin disk state.
4. PUT `{content: string}` as `application/json`, with the retained SHA-256
   enclosed in double quotes in `If-Match`. This precondition uses source bytes,
   not the top-level configuration `revision`.
5. Poll the operation at `Location`, respecting the positive `Retry-After`
   polling floor, until it succeeds or fails. A `202` means the server wrote the
   file and queued reload, not that the new configuration is active.
6. After successful reload, refetch `GET /config` for the accepted generation and
   `content_sha256`. If reload publishes a new generation and events are available,
   `generation.changed` announces it; the event does not waive the polling floor.

### Request

{% api_example replaceConfigSource request replacement http %}

The body accepts only `content`. It replaces the full file as UTF-8 text, including
its final newline if supplied. Empty text is a validation candidate, not a
malformed request. `resources.config.max_bytes` limits replacement UTF-8 bytes;
`limits.max_json_body_bytes` independently limits the encoded JSON body.
Exceeding either returns `413 request_too_large`.

`If-Match` accepts one quoted strong tag, not a wildcard, weak tag, or tag list.
The optional `Idempotency-Key` follows the [operation rules](operations.html):
within the running instance's retention window, the same caller, method, path,
key, and body return the original operation without another write or hash
check. Reusing the key with a different body returns `409 idempotency_conflict`.

### Validation and atomic write

For a new write, the server checks `If-Match` against the current on-disk content
hash, then validates the resulting source set in `full` mode with the replacement
substituted for the selected source. The check includes syntax, semantics, and
dependencies, using authorized local files and cached data only. The dependency
rules are the same as for [dry-run validation](#POST-api-v1-config-validate), including
the unfetched-subscription warning. Validation performs no network access or cache refresh.

If diagnostics contain any `error`, the server never writes a file or starts a
reload. It returns `422 unsupported_value` in the shared `{error, request_id}`
envelope, with `ConfigDiagnostic` entries in `error.details.diagnostics`.
Warnings and info alone do not prevent a write.

Otherwise, the server writes a temporary file in the source directory and
atomically renames it over the source, preserving the file mode. Concurrent API
writes serialize the hash check, validation, and replacement. The server checks
the on-disk hash again before replacement and rejects a changed hash with `412`.
After writing, it starts a reload operation with `kind: reload`.

{% api_example replaceConfigSource 202 queued http %}

Reload failure leaves the previous generation active, but does not roll back
the file write. Until successful reload, readback still describes the previously
accepted bytes, not the newly written file. Inspect the operation error and
reconcile disk state before retrying.

### Errors

| Status and code | Meaning and action |
|-----------------|--------------------|
| `403 permission_denied` | Missing `control`, disabled server-wide editing, or a read-only source. Do not offer writes for that source. |
| `404 resource_not_found` | Unknown source ID. Refetch the accepted source set. |
| `412 stale_revision` | The on-disk hash differs from `If-Match`; the server writes nothing. Reconcile the changed file before retrying. Refetching the accepted snapshot alone may still return the old hash. |
| `422 unsupported_value` | Full validation found error diagnostics; the server writes nothing and starts no reload. Display diagnostics and correct the candidate. |
| `428 precondition_required` | `If-Match` is missing; the server writes nothing. Supply the retained source hash. |

{% api_example replaceConfigSource 422 invalid %}

The editable GET example hashes to
`d1f62f00c6da9ec33956e66b8cc3b4670f164556fc12453193904af23451dec1`.
The PUT replacement hashes to
`92fe71cacbc73458f2da2a62363cec2e1cfae3ee0e3838acd7a90562e64f242a`.
Both include the final newline. After successful reload of that replacement,
the source's accepted hash becomes the latter.

## Creating a source

`POST /api/v1/config/sources` adds one new dae file and reloads. It requires
`control`, `resources.config.available`, `resources.config.writable`, and
`resources.config.create`. `create` is false by default and is true only when
`writable` is true. Without it, the request returns
`404 capability_not_supported`.

### Request

{% api_example createConfigSource request include http %}

| Field | Type | Description |
|-------|------|-------------|
| path | string | New file path relative to the main source's directory, in the same form as `ConfigSource.path`. |
| content | string | Complete UTF-8 dae text; empty text is a validation candidate, not a malformed request. |

`path` uses only normal segments: no leading `/`, no empty, `.`, or `..`
segment. It ends in `.dae`, has at most 1024 UTF-8 bytes, and contains no
control characters. The server resolves it inside the configuration root and
returns `400 invalid_request` for a malformed path or one whose parent resolves
outside the root, including through a symlink. A path that already names a file
or an accepted source returns `409 state_conflict`; creation never overwrites.

The same content limits as for [replacement](#Editing) apply, and so does the
optional `Idempotency-Key`.

### Validation and write

The server validates the resulting source set in `full` mode, with the new file
added at `path`, under the same dependency rules as a replacement. The file must
be loaded by an include pattern of that source set, for example
`include { config.d/*.dae }` in the main source for `config.d/proxies.dae`. If
no pattern matches, validation reports a `source-not-included` error diagnostic
on the main source. Any error diagnostic returns `422 unsupported_value` with
`error.details.diagnostics`; the server creates no file and starts no reload.

{% api_example createConfigSource 422 not_included %}

Otherwise the server writes a temporary file in the target directory and renames
it into place with a rename that fails if `path` exists, using the main
source's file mode. It then starts a reload operation with `kind: reload`.

{% api_example createConfigSource 202 queued http %}

If the reload fails, the previous generation stays active and the server
removes the file it created, unless the file at `path` is no longer the one it
wrote. The failed operation's `error.details.written` is `false` when the file
was removed and `true` when it remains on disk; reconcile a remaining file
before retrying. After a successful reload, `GET /config` lists the new source
with `path` as given, and it can be edited through
`PUT /config/sources/{source_id}`.

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
Diagnostic codes are adapter-defined, not members of the HTTP `ErrorCode` catalogue.

| Field | Type | Description |
|-------|------|-------------|
| level | string | `error`, `warning`, or `info`. |
| source_id | string | Source ID in the effective snapshot, validation request, or replacement's resulting source set. |
| line | integer or null | One-based source line; null when unknown. |
| column | integer or null | One-based UTF-8 byte column, not a character or UTF-16 offset; null when unknown. |
| span | object or null | `start_line`, `start_column`, `end_line`, `end_column`; one-based, start inclusive and end exclusive. End must not precede start; adapters may return zero-width spans. |
| code | string | Nonempty adapter-defined diagnostic code. |
| message | string | Safe operator-facing description, never raw parser output. |

Coordinates refer to the original source before redaction. When known, `line`
and `column` equal the span start. Unknown locations stay null; adapters must
not invent positions from setting names.

## Honk mapping

Honk implements native configuration readback, validation, source replacement,
and reload operations. These are separate from the Clash-compatible `/configs`
endpoint. The [implementation evidence](honk-mapping.html) describes an older
pinned source revision; it is not the current native API implementation status.
