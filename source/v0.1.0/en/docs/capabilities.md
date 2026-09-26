---
title: Capabilities
---

# GET /api/v1/capabilities

> Draft endpoint. This is the authoritative coarse-grained feature declaration
> for the running adapter. Resource responses may further narrow capabilities
> for an individual node or group; provider refresh support may vary by kind.

## Request

{% api_request getCapabilities %}

## Response

### Success (200 OK)

{% api_example getCapabilities 200 available %}

### Rules

- Every advertised resource key contains `available`.
- Top-level `limits` apply to every native route before resource-specific work
  is dispatched.
- A resource with `available: false` may omit its remaining fields.
- Optional metrics, enum values, and operation limits are explicit arrays or
  objects; clients must not infer them from the engine version.
- Unknown resource keys and fields must be ignored by clients.
- Requesting an unavailable resource or action returns `404` with
  `capability_not_supported`.
- Per-group and per-node capabilities may be stricter than this response.
- Limits are server-advertised ceilings. Exceeding a request rate returns
  `429`; exceeding fan-out or size returns `413`; a full bounded queue returns
  `503`. Traffic-history window and point limits instead return
  `400 invalid_request`.

`runtime_memory.metrics` contains canonical response field paths. An
implementation must not advertise a metric that it always reports as `null`.
`dns_cache.entry_kinds` declares which positive or negative cache entries can
be read and mutated without silently hiding another cache class.

`runtime_outbounds.available` declares the per-outbound cumulative counter
snapshot. `traffic_history.available` declares the bounded traffic ring;
when true, `max_window_seconds` and `max_points` are required positive safe
integers. They bound the look-back window and returned sample count, not a
retention guarantee. `memory_history` declares the bounded memory ring with
the same two limits. All three resources are optional and require `observe`.

`connections.available` gates the live list. When true, `can_close` and the
positive safe-integer `max_bulk_close` are required. `can_close: false` disables
both DELETE endpoints. When closing is enabled, `max_bulk_close` bounds the
entire selected set, including non-closable entries. See
[Closing connections](connections.html#Closing) for permissions, ownership,
filters, and errors.

`logs` advertises supported `levels`, `retention_seconds` and
`max_buffered_records`. Its bounded SSE feed carries sanitized log records,
separately from invalidation events.
`providers` advertises `can_refresh`, `can_manage` and `max_page_size`
(1–1000); refresh requires `control` and the operation resource, and
`can_manage` means the backend owns a writable main source and implements
provider create and delete. `nodes` advertises `can_manage` on the same terms
for inline nodes. `geodata` advertises `can_update` and the `assets` it reports
(`geosite`, `geoip`); update requires `control` and the operation resource.
`geodata.configurable_sources: true` means the download URLs and automatic
updates are managed through `geodata` in runtime settings and `GET /geodata`
reports the update status; it requires `runtime_settings.available` with
`geodata` in its `fields`, and absent means false. `rules` advertises `max_rules`,
including the fallback entry, for a complete running-generation dictionary.
Reads of logs, providers, nodes, geodata, and rules require `observe`. Available
resources must include their required capability fields; buffer and rule limits
are positive safe integers. See [Logs](logs.html), [Providers](providers.html),
[Nodes](node-latency.html), [Geodata](geodata.html), and [Rules](rules.html).

`runtime_settings.available` declares `GET`/`PATCH /api/v1/runtime/settings`;
when true, `fields` lists which settings the PATCH accepts on this backend.

`dns_log.available` declares the ring of recent client resolutions; when
true, `max_records` and `max_page_size` are required positive safe integers.

## Configuration capabilities

`resources.config.available` gates accepted-source readback. When available, it
requires `content`, `writable`, `max_bytes`, and `max_sources`.

`content` is reported for compatibility: an admitted caller receives source
text with only listener-secret values (`native_api.secret`, `clash_api.secret`)
masked. It does not grant access to those secrets. `max_sources` bounds the
complete source set; it does not permit truncation.

Writing requires `control`, the server-wide switch, and a writable source.
Advertising writes also requires full validation, reload, and operation support.
`create`, false by default, advertises `POST /config/sources` for adding a new
source file that an include pattern loads; it is true only when `writable` is.

Paths are returned as the configuration references them, with `absolute_path`
beside the relative `path`; only listener-secret values are masked, in paths,
source text and diagnostics alike. `detail=summary` is not a privacy tier. The
adapter sets `secrets_redacted` when it masked such a value in the response.

`resources.config_validate.available` independently gates dry-run validation.
When available, it requires `modes`, `max_bytes`, and `max_sources`; `modes` is a
nonempty unique subset of `syntax` and `full`.

See [Configuration](configuration.html) for redaction, byte accounting,
diagnostics, write preconditions, and recovery.

## Conformance profiles

`profiles` is an array, not a feature inferred from engine identity. The
example is an illustrative partial adapter, **not honk's current response**.

- **`base`** requires discovery, version, capabilities, runtime, the shared
  authentication/error/visibility rules, and honest capability declarations.
  Every resource key in this page's `resources` object MUST have an entry,
  even when unavailable; discovery/version/capabilities themselves are mandatory.
  Operations are required whenever an advertised action is asynchronous;
  events and mutations are otherwise optional. dae can implement this
  profile without claiming honk-only features.
- **`full_transparency`** additionally requires nodes, groups, connections,
  recorded flows and events; observed rule inputs/short-circuit decisions,
  dial-mode verification, DNS linkage, reroute reasons, actual member/leaf
  attempts, and lifecycle outcomes for managed traffic, including direct and
  blocked decisions. It requires all recorded-flow acceptance scenarios,
  no intentional sampling in these scopes, and explicit loss/retention
  accounting. Early bypass scope may remain uninstrumented only if declared
  as an exclusion; this is not a claim to observe all host traffic.

Profile support describes implemented instrumentation, not losslessness of
every snapshot. Buffer loss, disabled recording or redaction downgrades the
current coverage and affected traces even on a conforming engine. A
userspace-only adapter MUST NOT advertise `full_transparency`. A simulator,
Clash connection list, log parser, or map snapshot cannot satisfy it.

## Example

```bash
curl http://localhost:9527/api/v1/capabilities
```
