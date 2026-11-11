---
title: honk Notes
---

# honk notes

This page is not part of the contract. It records how honk, on its
`feat/native-api` branch, implements rules that the contract leaves to the
engine. Another engine may make different choices within the same rules.

## Listener configuration in honk

- honk configures the native listener under `experimental.native_api`; its
  settings include `enabled`, `listen`, `secret`, `allow_origins` and `ui`.
  `experimental.clash_api.external_controller` configures the separate
  Clash-compatible listener.
- The native and Clash-compatible APIs run on separate listeners and ports,
  with independent routing, authentication and CORS. Native configuration
  readback, validation, source replacement and reload are separate from the
  Clash-compatible `/configs` endpoint.
- An empty `allow_origins` does not disable the same-origin `/ui/` interface.
- honk's listener secrets are `experimental.native_api.secret` and
  `experimental.clash_api.secret`.

## Password sessions in honk

honk's password mode keeps at most 32 sessions; creating another expires the
oldest. Each session lasts 12 hours.
Another engine chooses its own limit and lifetime and reports the end in
`expires_at`.

## Geodata sources in honk

This section records how honk implements the
[geodata lifecycle](geodata.html#Effective-value-and-lifetime) on the
`feat/native-api` branch; another engine may reach the same effective values
another way.

- honk's configuration file can name the URL lists, the download route, and,
  in `assets.geodata`, `auto_update`, `cron` and `checksum`.
- honk keeps the geodata settings in its state database. Each stored URL list
  and the download route carry a mark saying whether the configuration file
  wrote them.
- At startup, before anything reads the settings, honk writes
  `geosite_download_url`, `geoip_download_url` and `geodata_download_detour`
  from the configuration file over the stored values. A list or route an
  earlier file wrote and the file no longer names is deleted, so the built-in
  value applies; a patched one is kept. `auto_update`, `cron` and `checksum`
  are written the same way. Naming only one of `auto_update` and `cron` takes
  the default for the other, and a value an earlier file wrote returns to its
  default once the file names neither.
- `source` is `config` while every stored list carries the file mark, `db`
  once a stored list does not, and `default` when no list is stored. A planned
  honk change renames `db` to `override`.
- A patch that sets one asset's URLs currently stores both lists as patched,
  freezing the other list at its effective value. A planned honk change stores
  only the patched list, as the contract requires.
- honk enforces 4 URLs per asset, an interval of 6 to 168 hours with a default
  of 24, and the `sha256sum` checksum method. A planned honk change advertises
  them as `max_urls`, `interval_hours` and `checksum`, with
  `lifecycle: {file_values: start, overrides_persist: true}`.
- The checksum URL is the file URL with `.sha256sum` appended to its path. A
  `404` accepts the file unverified; any other failure moves to the next URL.
- The next automatic attempt is due at the end of the last attempt, or, before
  the first, at process start or the latest `auto_update` change, plus the wait
  and a random delay of up to 60 minutes. After a failed attempt, the wait
  starts at one hour, doubles after each further failure, and is capped at the
  configured interval, or at the next cron fire under a cron schedule.
- honk's default schedule is cron `0 3 * * *`, daily at 03:00 local time. A
  cron schedule reads `interval_hours` as the advertised default, 24, and an
  interval schedule reads `cron` as null. Under a cron schedule the first check
  runs five minutes plus the random delay after startup if a time the
  expression names has passed since the last recorded check.
- honk accepts numbers, `*`, lists, ranges and steps in cron fields, day of
  week 0 and 7 as Sunday, and refuses names, macros such as `@daily`, a seconds
  field, an expression that fires more than four times a day, and one that
  never fires, with `400`.

## Runtime settings in honk

This section records how honk implements
[runtime settings](runtime-status.html#GET-api-v1-runtime-settings) and the
recorders on the `feat/native-api` branch.

- A PATCH accepts `log.buffered_records` and `dns_log.max_records` from 64 to
  512, `flows.max_flows` from 64 to 1024, and `flows.retention_seconds` from 1
  to 300. The startup values are 512, 512, 1024 and 300.
- `resources.runtime_settings.fields` lists `log.level` and
  `log.buffered_records` only when the log recorder is permitted. GET
  `/runtime/settings` reports every settings section, including values absent
  from that list.
- A client is attached while an admitted GET SSE stream on `/events` or
  `/logs` is open, and for 60 seconds after the last one closed or after a
  successful GET on `/flows`, `/flows/{flow_id}` or `/dns/log`. Settings reads,
  HEAD and rejected requests do not renew attachment. In `auto` mode the log
  and DNS-log recorders capture while a client is attached.
- The automatic flow recorder follows flow demand instead, so that an open
  panel does not record full traces for every connection. An admitted GET
  `/events` stream creates demand when its `kinds` include `flow.updated` or
  `flow.gap`, or when it sets a nonblank `flow_id` and its effective kinds
  include a flow kind. Demand lasts while such a stream is open, and for 60
  seconds after the last one closed or after a successful GET on `/flows` or
  `/flows/{flow_id}`. Event streams without `kinds`, `/logs` streams and
  `/dns/log` reads do not create demand, and attachment does not extend it.
- honk currently reports `resources.flows.recording` as `on` or `off` from
  whether the flow recorder is capturing, advertises the current `max_flows`
  and `retention_seconds` rather than its maxima, and omits `min_flows`,
  `logs.min_buffered_records`, `dns_log.min_records`, `logs.filters` and the
  eBPF attachment `kind`. A planned honk change reports all of them as the
  contract requires, reporting `resources.flows.recording: auto` when the flow
  recorder's mode is `auto`.
- `grace_remaining_seconds` counts the attachment grace only, not the
  flow-demand grace. Event capture runs while a client is attached or any
  permitted recorder is pinned on.

## Flow steps in honk

This section records honk-specific detail behind the
[flow record](flows.html) rules.

- honk hands UDP decisions between the kernel and userspace through NFQUEUE.
  Its `datapath` steps currently use the core action `drop` and the
  engine-defined actions `activate_direct` and `activate_proxy`
  (`control/connection/udp.rs`). They record the NFQUEUE activation, not each
  hold, arm, verdict and publication step.
- honk's UDP decision token is not a flow ID, and the persisted UDP token
  allocator is not changed to produce flow IDs.
- An outbound step's `data["x-honk"].mode_override` reports honk's Clash-mode
  override for the attempt: `none`, `direct`, `global` or `unknown`. It is not
  part of the shared step.
