---
title: Geodata
---

# Geodata

> Proposed endpoints for the geosite and geoip files the routing rules match
> against. Reading requires `observe`; updating requires `control` and the
> operation resource.

## Read the loaded assets

`GET /api/v1/geodata` requires `resources.geodata.available`; otherwise it
returns `404 capability_not_supported`.

{% api_request getGeoData %}

{% api_example getGeoData 200 loaded %}

One entry per kind in `resources.geodata.assets` describes the file the
running datapath was built from: `sha256` of the file, `size_bytes` as a
UInt64 decimal string, `modified_at` (nullable) and `source_redacted`, the
display-only download source. With several configured URLs it shows the first.
Reading never touches the network.

`source_redacted` and `fetched_url_redacted` use one display form. It keeps the
scheme, host, port and path of an absolute `http` or `https` URL, removes the
query, and replaces these path segments, compared in their percent-encoded
form, with `[redacted]`:

- the segment after one named `access_key`, `access_token`, `api_key`,
  `apikey`, `auth`, `auth_token`, `client_secret`, `credential`, `key`,
  `password`, `private_token`, `secret`, `sig`, `signature` or `token`,
  compared without regard to case;
- a segment that contains `:` or `=`;
- a UUID (hex digits in groups of 8, 4, 4, 4 and 12) or 32 hex digits;
- a segment of only ASCII letters, digits, `-` and `_` that has 16 or more
  characters including an upper-case letter, a lower-case letter and a digit,
  or 32 or more characters, no `-`, and is not all lower-case hex.

Listener-secret values are then masked. The field is null when no source is
configured or the URL does not parse, including a URL with userinfo or a
fragment. The display form is not the configured URL; `GET /runtime/settings`
returns that.

When `resources.geodata.configurable_sources` is true, the response also
carries the update status, and each asset reports where its file came from:

| Field | Meaning |
|-------|---------|
| assets[].fetched_url_redacted | Display-only URL the loaded file was downloaded from, in the display form above. Null when the engine did not download it, for example a file installed by a package. |
| assets[].verified | The file was downloaded and matched the checksum found by `resources.geodata.checksum`. False when no checksum was found for its URL, `checksum` is null, `verify_checksum` was false, or the engine did not download the file. |
| assets[].download_route | The route the file was downloaded through: `route` as `download` was set for that download, and `group_id` the group the request went through, including the group the routing rules chose. Null when the engine did not download the file. |
| last_checked_at | When the last update attempt, manual or automatic, finished, whatever its outcome. |
| last_updated_at | When an update last replaced a loaded file. |
| next_check_at | When the next automatic update is due, including its random delay and any backoff. Null while automatic updates are off. |
| last_error | A [SafeError](errors.html) with an engine-defined code when the last attempt failed on every URL; null otherwise. |
| required_codes | Per asset kind, the lowercase category names the active configuration references, sorted and without attribute suffixes. |

`last_checked_at` and `last_updated_at` are null before the first attempt;
`next_check_at` is set from startup while automatic updates are on. An engine
without the capability omits all of these fields.

{% api_example getGeoData 200 packaged %}

`required_codes` lets a client check a smaller file before choosing it: a
replacement that lacks any listed category fails the update, so a panel can warn
about the missing categories up front instead.

## Update the assets

`POST /api/v1/geodata/update` takes no body and requires
`resources.geodata.can_update`.

{% api_request updateGeoData %}

{% api_example updateGeoData 202 queued http %}

Poll `Location` using the [operation contract](operations.html), obeying
`Retry-After`. The kind is `geodata_update`. The engine downloads every asset
from its source into a temporary file, verifies it parses, replaces the loaded
file and reloads the datapath once, emitting `generation.changed`. An asset
that fails to download or parse leaves the loaded file in place and fails the
operation with a SafeError. Success returns the new GeoData in `result`.
Identical bytes leave the loaded file and the generation unchanged.

With several URLs for an asset, the engine tries them in order and moves to
the next only when one fails:

- a connection error or the per-URL deadline;
- any status other than `200`. Redirects are not followed, so a link that
  redirects, such as a GitHub `/releases/download/` URL, never works; use a
  raw or CDN URL that serves the file directly;
- a failed checksum. `resources.geodata.checksum` names how the engine finds
  the checksum:
  - `sha256sum`: it appends `.sha256sum` to the URL path, keeping any query,
    fetches that URL and compares the first field of the response with the
    file's SHA-256. A `404` means no checksum is published, and the file is
    accepted unverified. A mismatch, any other status, or a connection error
    fails the URL.
  - `pinned`: it compares the file with a SHA-256 it holds for that URL, for
    example one shipped with its built-in sources. A mismatch fails the URL; a
    URL without a pinned digest is accepted unverified.
  - null: the engine cannot verify downloads and accepts every file
    unverified.

  With `verify_checksum` false, the engine requests no checksum and accepts
  the file unverified.

Every request, the checksum included, leaves through the route in
`download` (see below). A URL the route cannot reach, because the group has no
usable member or the routing rules send it to `block`, counts as a connection
error, and the engine tries the next URL. It never falls back to direct.

The update also fails, keeping the loaded file, when the new file lacks a
category the active configuration uses. The engine writes updated files to its
own data directory and never overwrites files a package manager installed.

Downloads follow the [outbound-request policy](api-config.html#Outbound-requests).

A distinct update while one is queued or running returns
`409 state_conflict`. Replaying the same accepted `Idempotency-Key` returns
its original operation. A full bounded queue returns
`503 temporarily_unavailable` with a positive `Retry-After`. An automatic
update runs as the same operation kind, so a manual request while one runs also
returns `409 state_conflict`.

## Configure the sources

When `resources.geodata.configurable_sources` is true, the download URLs and
automatic updates are the `geodata` section of
[runtime settings](runtime-status.html#GET-api-v1-runtime-settings), read with
`GET` and changed with `PATCH /api/v1/runtime/settings`.

{% api_example getRuntimeSettings 200 current %}

| Field | Meaning |
|-------|---------|
| geosite.urls, geoip.urls | Up to `resources.geodata.max_urls` URLs per asset, in fallback order, each at most 4096 bytes with no userinfo or fragment. |
| auto_update.enabled | Update on a schedule. On by default. |
| auto_update.interval_hours | Hours between automatic updates, within `resources.geodata.interval_hours`, when `cron` is null or absent. Under a cron schedule it reads the advertised default and has no effect. |
| auto_update.cron | Five-field cron expression (minute, hour, day of month, month, day of week) in the engine's local time zone, or null when the interval applies. An engine without cron schedules omits it. |
| source | Read-only: where the effective URL lists came from, `config`, `override` or `default`. |
| download.route | How downloads leave the device: `routing` (default), `group` or `direct`. |
| download.group_id | The group for `route: group`, as in `GET /groups`; null otherwise. |
| verify_checksum | Verify each download by the advertised `checksum` method and reject a file that does not match it. True when nothing is set; an engine that omits the field behaves as true. |

Every admitted caller reads the URLs as written, with only listener-secret
values masked; see the [visibility table](api-config.html#Visibility).

### Effective value and lifetime

The following rules determine each field's effective value. A field has a file
value, an override set by `PATCH`, or neither, in which case the engine's
built-in value applies. Which fields the configuration file can name is
engine-specific.

`resources.geodata.lifecycle` advertises when the engine takes file values
and how long overrides last:

- `file_values: start`: the engine takes file values at process start only,
  so activations never change geodata settings and a changed file value takes
  effect at the next start. `activation`: it also takes them at each
  configuration activation.
- `overrides_persist: true`: an override lasts across restarts. `false`: it
  lasts until the process exits.

Each field changes as follows; "file values taken" means process start, and
also activation under `file_values: activation`.

| Event | Field last set by the file | Field set by `PATCH` |
|-------|----------------------------|----------------------|
| File values taken, the file names the field | Takes the file value | Takes the file value and loses the override |
| File values taken, the file no longer names the field | Returns to the built-in value | Keeps the override |
| `PATCH` sets the field, even to its current value | Becomes an override | Keeps the override, with the new value |
| `PATCH` omits the field | Unchanged | Unchanged |
| `"geodata": null` | Returns to the built-in value until file values are next taken | Returns to the built-in value |
| Activation under `file_values: start` | Unchanged | Unchanged |
| Restart under `overrides_persist: false` | Takes the file value again | Returns to the file or built-in value |

`source` tells a client where the effective URL lists came from:

- `config`: every list that is not built in comes from the configuration file.
  A panel can still edit them, and should say that the file sets them again at
  the next start.
- `override`: a patch set at least one list that is still in force, even to the
  URLs the file names.
- `default`: both assets use the engine's built-in URLs.

An asset with neither a file value nor an override uses its built-in URLs under
any `source`. The download route does not affect `source`.
[honk notes](honk-notes.html#Geodata-sources-in-honk) describe how honk stores
and reconciles these values.

{% api_example getRuntimeSettings 200 config_sources %}

A patch may set URLs under any `source`. Setting `geosite` or `geoip` overrides
only that asset's list, so `source` becomes `override`; the other list keeps
its value and where it came from. A `urls` list replaces the whole list.
`auto_update`, `download` and `verify_checksum` are each overridden on their
own and never change `source`. More URLs than `max_urls`, an interval
outside `interval_hours`, `interval_hours` together with `cron`, or a `cron`
expression the engine refuses returns `400 invalid_request`.
Plain `http` URLs are accepted, but a file fetched without a published checksum
is unverified, so prefer `https`. Changing `geodata` requires `control` and a
credential; an anonymous loopback caller gets `403 permission_denied`. A patch
never downloads anything; queue an update to fetch from the new URLs.

{% api_request patchRuntimeSettings geodata_sources %}

Some mirrors answer the checksum URL with an error page, or a status such as
`403` or `429`, instead of `404`, so every update from them fails. Setting
`verify_checksum` to false lets such a mirror work: the engine sends no
checksum request and accepts each file unverified, with `verified` false.
Prefer a mirror that publishes checksums.

{% api_request patchRuntimeSettings geodata_skip_checksum %}

{% api_example patchRuntimeSettings 200 geodata_stored %}

{% api_request patchRuntimeSettings geodata_auto_update %}

`interval_hours` switches to the interval schedule and `cron` to the cron
schedule; `enabled` alone keeps the current one. The engine chooses the default
schedule, and may accept fewer expressions than standard cron.

{% api_request patchRuntimeSettings geodata_auto_update_cron %}

{% api_request patchRuntimeSettings geodata_reset %}

## Choose the download route

`download` decides how every geodata request leaves the device:

- `routing`, the default: the routing rules decide, as for user traffic, so a
  rule can send the download to a node, a group, direct or `block`. Every
  download the engine makes itself follows the routing rules unless configured
  otherwise.
- `group`: always through the group in `group_id`, whatever the rules say.
- `direct`: straight to the host, outside the routing rules.

{% api_request patchRuntimeSettings geodata_download %}

`group_id` is a current group id from `GET /groups`, required for `group` and
not allowed otherwise. An id that is not a current group returns
`409 state_conflict` and changes nothing. `download` is overridden on its own,
like `auto_update`. If the chosen group later disappears from the
configuration, `group_id` reads null and downloads fail until the route is
changed.

The route must be able to carry the request when the update runs. Just after
startup the routing rules may not be loaded yet, or a group's health checks may
not have finished; a request the route cannot carry fails that URL like a
connection error, the engine tries the next URL, and when all fail it reports
`last_error`. It never switches to direct on its own, so a download meant for a
proxy is not sent in the clear.

Automatic updates are on by default, on the engine's default schedule, so the
loaded files follow the upstream lists without a manual update. Set
`auto_update.enabled` to false to stop them.

Under an interval schedule, the next automatic attempt is due a wait plus a
random delay after the last attempt, manual or automatic, finished. Under a
cron schedule it is due at the first time the expression names after the last
recorded attempt, plus the random delay; after a restart the schedule continues
from that record. Until this process finishes its first
attempt, the wait counts from process start or from the latest change to
`auto_update`, whichever is later, so a start never downloads at once. The wait
is the interval, or the time to the next cron fire; after a failed attempt the
engine may wait less, never more, and a success restores the schedule. The
engine bounds the random delay, which spreads downloads from many devices, and
adds it to every wait, retries included. `next_check_at` reports the due time
with the delay, so a retry is due no later than the interval or the next cron
fire, plus the delay. Changing `auto_update` recomputes the
due time from the last finished attempt, or from the time of the change when
there is none yet. honk's delay and backoff values are in the [honk
notes](honk-notes.html#Geodata-sources-in-honk).
