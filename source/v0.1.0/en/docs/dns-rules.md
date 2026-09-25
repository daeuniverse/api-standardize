---
title: DNS Rules
---

# GET /api/v1/dns/rules

> Read-only DNS routing rules for the running routing generation.
> Requires `observe` and `resources.dns_rules.available`. Rules are edited
> through their configuration sources, not a rule-level write endpoint.

## Request

{% api_request listDnsRules %}

## Response

{% api_example listDnsRules 200 running %}

The rules come from the running generation, which is the accepted
configuration. A candidate that failed validation or has not been reloaded is
not reflected.

`request` and `response` hold the two rule lists of `dns { routing { … } }`,
each in evaluation order and ending with exactly one `kind: fallback` entry.
Request rules decide how a query is resolved; response rules decide what
happens to the answer. A fallback the configuration does not write still
appears, with the backend's default action and a null `source`. A rule the
parser omitted with a diagnostic is not listed; read the diagnostics from
[GET /config](api-config.html).

Each entry has `rule_id`, zero-based `index`, `expression` (the rule's
source text as written, for display), `action`, `upstream`, nullable `source`, and `kind`
(`rule` or `fallback`). `source` has the same shape as in
[GET /rules](rules.html): a redacted display `file`, the configuration
`source_id`, a one-based `line`, and a nullable one-based UTF-8 byte `column`.

| List | `action` | Meaning | `upstream` |
|------|----------|---------|------------|
| request | `upstream` | Send the query to the named upstream | Upstream name |
| request | `asis` | Send the query to its original destination | null |
| request | `reject` | Answer with an empty result | null |
| response | `accept` | Keep the answer | null |
| response | `reject` | Replace the answer with an empty one | null |
| response | `requery` | Resolve the query again through the named upstream | Upstream name |

In the configuration, `upstream` and `requery` are written as a bare upstream
name. Request conditions are `qname`, `qtype` and `sip`; response rules may also
use `upstream` and `ip`.

`upstream` is the name as the engine resolved it and may differ in case from
the source text; `expression` keeps the text as written.

`rule_id` is stable within a generation, unique across both lists, and
addresses the rule. Address a rule by `(generation_id, rule_id)`, never by
expression or index alone.

## Generation changes and limits

Refetch on `generation.changed` from the [events feed](events.html), or poll
and replace both lists when `generation_id` changes. This endpoint has no
pagination.

`resources.dns_rules.max_rules` bounds each list, including its fallback.
Never truncate silently. Return `503 temporarily_unavailable` if a list cannot
fit, or `503 snapshot_unavailable` if the adapter cannot pin one coherent
generation.

A backend that does not implement this endpoint advertises
`resources.dns_rules.available: false` and returns
`404 capability_not_supported`. A
client then shows no DNS rule list.

## Editing

Edit DNS rules the same way as [traffic rules](rules.html#Editing): open
`source.source_id` at `source.line` and replace the whole source with
`PUT /api/v1/config/sources/{source_id}`, following the
[configuration editor flow](configuration.html#Editor-flow). Do not offer
source editing when `source` is null or the complete editable text is
unavailable.
