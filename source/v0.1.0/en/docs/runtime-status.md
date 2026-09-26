---
title: Runtime
---

# GET /api/v1/runtime

> Draft endpoint. This read-only snapshot describes the running process, active
> configuration generation, eBPF datapath summary, and traffic visible to the
> engine. Detailed eBPF state is available from [`GET /api/v1/datapath`](datapath.html),
> and the independently pollable memory snapshot is available from
> [`GET /api/v1/runtime/memory`](runtime-memory.html).

Runtime values describe traffic visible to the engine, not every packet on the
host. Unavailable nullable measurements are `null`; state fields use their
documented values, including `unknown`. A measured zero is numeric `0` for
bounded counts and decimal string `"0"` for `uint64` quantities.

## Request

{% api_request getRuntime %}

`detail=summary` is the default and omits `process.pid`. `detail=full` includes
it when the adapter can observe it.

## Response

### Success (200 OK)

{% api_example getRuntime 200 snapshot %}

### Fields

| Field | Type | Description |
|-------|------|-------------|
| observed_at | string | Snapshot timestamp (RFC3339). |
| instance_id | string | Unique adapter process incarnation; changes on restart. |
| lifecycle.state | string | `starting`, `running`, `reloading`, `suspended`, `draining`, `degraded`, or `failed`. |
| lifecycle.started_at | string or null | Process start time, when known. |
| lifecycle.uptime_seconds | decimal uint64 string or null | Process uptime. |
| generation.active_id | string | Opaque active runtime generation. |
| generation.config_revision | opaque string or null | Configuration revision used by the active generation; preserve it without numeric parsing. |
| generation.state | string | `active` or `reloading`. A pending generation is not active. |
| datapath.kind | string | `ebpf`, `userspace`, `mock`, or `unknown`. |
| datapath.state | string | `active`, `degraded`, `detached`, `failed`, `disabled`, or `unknown`. |
| datapath.visibility | string | `full`, `partial`, or `none` for traffic visible to the datapath. |
| datapath.ebpf | object or null | eBPF state summary when the datapath uses eBPF. |
| traffic.scope | string | Scope of the counters, normally `visible`. |
| traffic.observed_by | string | `userspace`, `ebpf`, or `mixed`. |
| traffic.counter_since | string or null | Start time of the reported cumulative counters. |
| traffic.sampled_at | string or null | Traffic sample timestamp (RFC3339), or null when unavailable. Never substitute the HTTP snapshot timestamp. |
| traffic.connections | object | Currently visible TCP, UDP, and total connection counts. Each count is a bounded JSON integer or `null` when unobservable. |
| traffic.bytes | object | Cumulative visible bytes. Each value is a decimal uint64 string or `null` when unobservable. |
| traffic.rates | object or null | Current rates. `null` when unavailable; `window_seconds` stays numeric and byte rates are decimal uint64 strings or `null`. |
| process.pid | uint32 or null, optional | Engine process ID with `detail=full`. |
| process.cpu_percent | number or null | CPU time the engine process used over the adapter's latest sampling interval, as a percentage of one CPU. 100 means one core fully busy; the value may exceed 100 on multi-core hosts. Null until two samples exist or when unmeasurable. |
| last_reload | object or null | Most recent reload operation and its result. |

`traffic.rates.window_seconds` is the duration of the sampling interval
ending at `traffic.sampled_at`. A cached sample retains its original
timestamp; `counter_since` instead marks the cumulative counter reset
boundary. A null sample timestamp does not establish freshness.

`datapath.ebpf` is the eBPF summary, or null when inapplicable.
[Datapath](datapath.html) defines its states and the readiness rules for eBPF,
userspace, and mock backends. Loaded programs alone do not establish an active datapath.

> **Note:** Per-connection details and byte counters are available from
> [`GET /api/v1/connections`](connections.html). They carry the same visibility limits.

Per-outbound cumulative counters and bounded traffic history are separate
resources below. Summing live connection bytes by `outbound` omits closed,
truncated, and unobserved connections; it is not a usage total.

During reload, the old active generation remains reported until the new
generation has passed configuration validation and datapath publication. A
failed reload therefore leaves `generation.active_id` unchanged and is exposed
through `last_reload`.

Generation identifiers are adapter-owned, instance-scoped opaque references
with distinct namespaces for runtime commits and kernel policy publications.
DNS cache epochs, outbound-registry generations, diagnostic generations and
eBPF double-buffer slot numbers are not interchangeable configuration
revisions. A reload that reuses an unchanged kernel policy can promote a new
runtime generation while retaining the old datapath generation ID. The
adapter must retain that relationship, not forge equal strings.

Runtime fields are a coherent control-plane snapshot; independently sampled
kernel/traffic counters retain their own timestamps. Reads of two separate
HTTP resources are not an atomic transaction. Flow steps capture their
actual producer generation and may legitimately span multiple generations.

## Example

```bash
curl "http://localhost:9527/api/v1/runtime?detail=full"
```

## GET /api/v1/runtime/outbounds

Requires `observe` and `resources.runtime_outbounds.available`. This snapshot
mirrors honk's Clash-surface [`/stats` outbound counters](honk-mapping.html#outbound-counters),
not a sum of the current `/connections` page.

{% api_request getRuntimeOutbounds %}

{% api_example getRuntimeOutbounds 200 snapshot %}

| Field | Type | Description |
|-------|------|-------------|
| observed_at | string | Counter snapshot timestamp (RFC3339). |
| counter_since | string | Shared start/reset boundary for all cumulative counters (RFC3339). |
| outbounds | array | Counters attributed to engine-visible outbounds. |
| outbounds[].name | string | Outbound name retained with the counters, not a stable node/group ID. |
| outbounds[].kind | string | `group`: configured group; `node`: leaf node; `builtin`: engine builtin such as direct/block. |
| outbounds[].active_connections | safe unsigned integer | Currently active connections attributed to this outbound. |
| outbounds[].total_connections | decimal uint64 string | Cumulative connections attributed to this outbound since `counter_since`. |
| outbounds[].upload_bytes | decimal uint64 string | Cumulative visible uploaded bytes since `counter_since`. |
| outbounds[].download_bytes | decimal uint64 string | Cumulative visible downloaded bytes since `counter_since`. |
| outbounds[].errors | decimal uint64 string | Cumulative outbound failures since `counter_since`; policy blocks are not errors. |

Restart or counter reset changes `counter_since`; clients must not compute
deltas across that boundary. A reload changes it only if the counters reset.
Closed connections remain in cumulative totals. Newly observed outbounds
start at zero within the same interval; retain old names and kinds with
their counters rather than relabelling them from today's registry.
Rows reflect the producer's attribution, not every group and node on a
selection path; do not duplicate counters across `chain` entries.
These counters cover visible traffic only, not all kernel-direct or blocked
traffic. Zero denotes a measured zero, never unsupported accounting.

## GET /api/v1/runtime/traffic/history

Requires `observe` and `resources.traffic_history.available`. The producer
samples visible runtime rates and active connection counts into a bounded
in-memory ring independently of HTTP reads.

### Request

{% api_request getTrafficHistory %}

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| window_seconds | positive safe integer | Advertised `max_window_seconds` | Look-back window ending at `observed_at`. |
| max_points | positive safe integer | Advertised `max_points` | Maximum returned sample count. |

Both limits are under `resources.traffic_history`. Invalid, zero, negative,
or non-integer values and requests above either advertised limit return
`400 invalid_request`; the server must not silently clamp them.

{% api_example getTrafficHistory 400 window_too_large %}

{% api_example getTrafficHistory 400 too_many_points %}

### Response

{% api_example getTrafficHistory 200 recent %}

| Field | Type | Description |
|-------|------|-------------|
| observed_at | string | History snapshot timestamp (RFC3339), not a replacement for sample timestamps. |
| window_seconds | positive safe integer | Requested look-back window, even when retention is shorter. |
| sampled_every_seconds | positive number | Nominal interval between returned samples after thinning; recorder interval for an empty result. |
| samples | array | At most `max_points` samples, oldest first, in `(observed_at - window_seconds, observed_at]`. |
| samples[].sampled_at | string | Original sample timestamp (RFC3339). |
| samples[].upload_bytes_per_second | decimal uint64 string or null | Sampled visible upload rate, or null when unavailable. |
| samples[].download_bytes_per_second | decimal uint64 string or null | Sampled visible download rate, or null when unavailable. |
| samples[].connections | safe unsigned integer or null | Visible active TCP and UDP connections at the sample, or null when unavailable. |

When the window holds too many points, select every Nth stored sample
backwards from the newest to fit `max_points`, then return them oldest
first. Choose the smallest positive N that fits the limit. Preserve original
timestamps and rates; `sampled_every_seconds` describes the resulting
cadence, not a new rate averaging interval.
Missed intervals remain timestamp gaps; unavailable measurements are null,
not zero. A cumulative counter reset makes the spanning rate sample null,
not a negative rate or a fabricated spike.

The ring is bounded by age and capacity and is cleared on process restart.
It may return fewer samples than requested, or an empty array before
sampling; a requested window is not a retention guarantee.
Together with [memory history](runtime-memory.html#GET-api-v1-runtime-memory-history)
this is the only sampled-metric history the native API serves; retained
flow traces and operation results remain separate records. SSE does not
replay traffic history, even with `Last-Event-ID`; fetch this resource on
first open or reconnect rather than treating invalidations as samples.

## GET /api/v1/runtime/settings

Requires `observe` and `resources.runtime_settings.available`. Reports the
values the running engine uses for what a panel may tune without a reload:
the log level and replay ring, the DNS log ring, and flow retention.

{% api_example getRuntimeSettings 200 current %}

| Field | Ceiling | Meaning |
|-------|---------|---------|
| log.level | `logs.levels` | Minimum severity the engine emits. |
| log.buffered_records | `logs.max_buffered_records` | Log replay ring capacity, at least 64. |
| dns_log.max_records | `dns_log.max_records` | DNS log ring capacity, at least 64. |
| flows.max_flows | `flows.max_flows` | Retained flows, at least 64. |
| flows.retention_seconds | `flows.retention_seconds` | Maximum age after termination; capacity pressure may evict a flow sooner. |
| source | | `config` while every value comes from the activated configuration, `runtime` once a PATCH overrode one. |
| geodata | | Geodata download URLs, download route and automatic updates, with their own read-only `source` for the URLs; URLs are redacted except for an authenticated caller with `control`. Present when `resources.geodata.configurable_sources` is true. See [Geodata](geodata.html#Configure-the-sources). |
| recording | | Read-only recorder state: `flows`, `logs` and `dns_log` each report `allowed`, `mode` (`auto`, `on`, `off`) and `active`; `events.active` reports event capture; `grace_remaining_seconds` counts down after the last attached client left and does not report the flow-demand grace. |

A client is attached while an admitted GET SSE stream on `/events` or `/logs`
is open, or for 60 seconds after the last stream closed or a successful GET on
`/flows`, `/flows/{id}` or `/dns/log`. Settings reads, HEAD and rejected
requests do not renew attachment. In `auto` mode the log and DNS-log recorders
capture only while a client is attached.

In `auto` mode the flow recorder follows flow demand instead, so that an open
panel does not record full flow traces for every connection. An admitted GET
`/events` stream creates flow demand when its `kinds` include `flow.updated` or
`flow.gap`, or when it sets a nonblank `flow_id` and its effective kinds include
a flow kind. Demand lasts while such a stream is open, and for 60 seconds after
the last one closed or after a successful GET on `/flows` or `/flows/{id}`.
Event streams without `kinds`, `/logs` streams and `/dns/log` reads do not
create demand, and general attachment does not extend the flow grace. Recording
starts on attachment or demand, so the first history a panel reads may be empty.

## PATCH /api/v1/runtime/settings

Requires `control`. Only the fields listed in `resources.runtime_settings.fields`
may appear; the body merges, an absent field keeps its value. `record_flows`,
`record_logs` and `record_dns_log` take `true` (keep the recorder on without
clients), `false` (force it off) or `"auto"` (the startup default: flows follow
flow demand, logs and DNS logs follow attachment); pinning a recorder the configuration forbids rejects the whole patch.

{% api_request patchRuntimeSettings debug %}

{% api_example patchRuntimeSettings 200 changed %}

Every value is checked against its ceiling before anything changes: an
unadvertised level, a ring below 64 records, or a value above its ceiling
returns `400 invalid_request` and changes nothing. Shrinking a ring drops its
oldest records and expires cursors older than the new floor. The change
applies immediately, is not written to the configuration file, and lasts
until the process restarts or the next configuration activation resets it.

{% api_example patchRuntimeSettings 400 above_ceiling %}

`geodata` differs: the backend stores it and leaves the top-level `source`
unchanged. It needs an authenticated caller. URLs named in the configuration
file are written into it at startup, replacing patched URLs. See [Geodata](geodata.html#Configure-the-sources).
