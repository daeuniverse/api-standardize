---
title: Routing Trace
---

# GET /api/routing/trace

> Draft endpoint. Dry-runs the active routing rules against a hypothetical
> flow and returns the per-rule decision path together with the outbound that
> would have been selected. The evaluation itself never installs datapath
> state and never dials the traced flow through any outbound; the only
> network activity is the engine's own DNS resolution for name-only
> queries, which follows the configured DNS chain and may itself transit
> an outbound.

"Why did this connection go through this group?" is the most common routing
question. Neither a configuration dump nor a connection list can answer it:
the answer depends on rule semantics (order, conjunction short-circuits,
fallback) and on inputs the client usually does not have, such as the
resolved IPs behind a name. This endpoint answers it by evaluating the same
rule set the engine would use for a real connection — the connection
routing rules (dae's `routing` section); the engine's DNS routing (dae's
`dns.routing`) is out of scope.

## Request

```http
GET /api/routing/trace?domain=example.com&port=443&network=tcp HTTP/1.1
Host: localhost:9527
```

## Query Parameters

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| domain | string | - | Destination hostname, as the engine would observe it (e.g. a sniffed name). At least one of `domain` or `ip` is required |
| ip | string | - | Destination IP. May be specified multiple times (e.g. `?ip=1.1.1.1&ip=4.4.4.4`); duplicates are evaluated once, and an engine may bound the address count (see Name Resolution). IPv6 literals are written bare, without brackets. At least one of `domain` or `ip` is required |
| port | int | 0 | Destination port (0 = unspecified) |
| network | string | - | `tcp` or `udp`; when unspecified, `l4proto()` rules are reported as `indeterminate` |
| pname | string | - | Process name as the engine would observe it (the input matched by `pname()` rules) |
| src | string | - | Source IP (the input matched by `sip()` rules) |

Scalar parameters must appear at most once.

## Name Resolution

When `domain` is given without `ip`, the engine resolves the name through its
own DNS chain and reports one evaluation per resolved address. This is
deliberate: production routing decides per connection, and different
addresses of the same name can select different outbounds. Divergent results
across addresses are a property of the rule set, not an error. The lookup is
real, so the queried name is visible to the configured DNS upstreams;
lookups may read the runtime DNS cache, and if the engine rate-limits real
DNS queries it should apply equivalent limits here. Every resolved address
is evaluated; an engine may bound the address count — resolved or
caller-supplied — and must then set `truncated` in the response.

When both `domain` and `ip` are given, no resolution happens; every `ip` is
evaluated with the name attached, mirroring a connection whose domain was
sniffed.

When only `ip` is given, each address is evaluated with no name attached;
rules that depend on a name (`domain(...)` rules, including their
`geosite:` forms) are reported as `indeterminate`.

A resolution failure — including a name that resolves to zero addresses —
is not fatal. The engine still evaluates with the name only and marks
IP-dependent rules as `indeterminate`; the response contains a single
evaluation with `ip: null`.

## Response

### Success (200 OK)

```json
{
  "observed_at": "2026-08-25T10:00:00Z",
  "generation_id": "17",
  "input": {
    "domain": "example.com",
    "ip": null,
    "port": 443,
    "network": "tcp",
    "pname": null,
    "src": null
  },
  "truncated": false,
  "evaluations": [
    {
      "ip": "93.184.216.34",
      "steps": [
        {
          "index": 0,
          "rule": "domain(geosite:category-ads-all) -> block",
          "result": "not_matched",
          "reason": null,
          "conditions": []
        },
        {
          "index": 1,
          "rule": "domain(example.com) && dip(geoip:private) -> direct",
          "result": "not_matched",
          "reason": null,
          "conditions": [
            { "expr": "domain(example.com)", "result": "matched" },
            { "expr": "dip(geoip:private)", "result": "not_matched" }
          ]
        },
        {
          "index": 2,
          "rule": "dip('2606:2800::/32') -> direct",
          "result": "not_matched",
          "reason": null,
          "conditions": []
        },
        {
          "index": 3,
          "rule": "pname(curl) -> direct",
          "result": "indeterminate",
          "reason": "pname rule evaluated without a process name",
          "conditions": []
        },
        {
          "index": 4,
          "rule": "fallback: mygroup",
          "result": "matched",
          "reason": null,
          "conditions": []
        }
      ],
      "outbound": "mygroup",
      "indeterminate": true,
      "must": false,
      "mark": null
    },
    {
      "ip": "2606:2800:220:1:248:1893:25c8:1946",
      "steps": [
        {
          "index": 0,
          "rule": "domain(geosite:category-ads-all) -> block",
          "result": "not_matched",
          "reason": null,
          "conditions": []
        },
        {
          "index": 1,
          "rule": "domain(example.com) && dip(geoip:private) -> direct",
          "result": "not_matched",
          "reason": null,
          "conditions": [
            { "expr": "domain(example.com)", "result": "matched" },
            { "expr": "dip(geoip:private)", "result": "not_matched" }
          ]
        },
        {
          "index": 2,
          "rule": "dip('2606:2800::/32') -> direct",
          "result": "matched",
          "reason": null,
          "conditions": []
        },
        {
          "index": 3,
          "rule": "pname(curl) -> direct",
          "result": "skipped",
          "reason": "an earlier rule already decided the flow",
          "conditions": []
        },
        {
          "index": 4,
          "rule": "fallback: mygroup",
          "result": "skipped",
          "reason": "an earlier rule already decided the flow",
          "conditions": []
        }
      ],
      "outbound": "direct",
      "indeterminate": false,
      "must": false,
      "mark": null
    }
  ]
}
```

### Fields

| Field | Type | Description |
|-------|------|-------------|
| observed_at | string | Evaluation timestamp (RFC3339) |
| generation_id | string or null | Opaque revision identifier of the evaluated rule set, when the engine exposes one |
| input | object | Echo of the request inputs |
| truncated | bool | Whether an engine-side limit on the address count (resolved or caller-supplied) omitted some addresses from `evaluations` |
| evaluations | array | One entry per evaluated destination address; the order is unspecified — clients key entries by `ip` |

### Input Object

| Field | Type | Description |
|-------|------|-------------|
| domain | string or null | Echo of the `domain` parameter |
| ip | array of string or null | Echo of the caller-supplied `ip` parameters |
| port | int | Echo of the `port` parameter (0 = unspecified) |
| network | string or null | `tcp`, `udp`, or `null` when unspecified |
| pname | string or null | Echo of the `pname` parameter |
| src | string or null | Echo of the `src` parameter |

### Evaluation Object

| Field | Type | Description |
|-------|------|-------------|
| ip | string or null | Destination address this evaluation ran against (`null` when the name failed to resolve) |
| steps | array | Decision path, in rule order |
| outbound | string or null | Outbound that would be selected for a connection to this address; `null` when the engine cannot produce a decision (engines that permit a rule set without fallback) |
| indeterminate | bool | Whether the decision path contains at least one `indeterminate` step; when true, the production choice for a real connection may differ |
| must | bool | Whether the decision carries dae's `must` flag (the flow's DNS traffic is not hijacked into the engine); set by a matched `must_*` outbound, including a `must_` fallback. Engines without this concept always report `false` |
| mark | int or null | Routing mark (fwmark) the engine would attach to the connection; `null` when none. Engines without marking always report `null` |

### Step Object

| Field | Type | Description |
|-------|------|-------------|
| index | int | Rule order (0-based) within the evaluated rule set |
| rule | string | Display form of the rule |
| result | string | `matched`, `not_matched`, `skipped`, or `indeterminate` (see Result Semantics) |
| reason | string or null | Why the result is `skipped` or `indeterminate` |
| conditions | array | Subcondition evaluations, when the engine exposes them; empty for single-condition rules or when the engine does not expose subcondition detail |

> **Note:** The configured fallback, if any, appears as the last step; it
> reports `matched` when reached and `skipped` when an earlier rule
> already decided the flow. dae always has a fallback — an unconfigured
> `fallback:` defaults to `direct` — and the implicit fallback appears as
> the last step like any other (so for dae, `outbound` is never `null`).
> The `rule` display form preserves outbound modifiers such as `must_*`
> and `mark:`. The `rule` and `expr` display forms use the configuration
> spelling where available; engines may normalize the rule set (merge
> rules, reorder subconditions within a rule, rewrite aliases such as
> `dip` to `ip`, expand `geosite:`/`geoip:` macros) before evaluation, so
> `index` is the order within this response.

### Condition Object

| Field | Type | Description |
|-------|------|-------------|
| expr | string | Display form of the subcondition |
| result | string | `matched`, `not_matched`, `skipped`, or `indeterminate` |

> **Note:** The `expr` display form preserves the original writing,
> including any `!` negation; conditions appear in evaluation order.
> Conditions have no `reason`; when a rule is `indeterminate` because of
> one subcondition, the step-level `reason` explains it.

### Errors

#### 400 Bad Request

Returned when neither `domain` nor `ip` is given, a parameter is invalid,
or a scalar parameter is repeated.

```json
{
  "ok": false,
  "error": "At least one of domain or ip is required"
}
```

#### 404 Not Found

Returned when the engine does not implement offline routing evaluation.
This aligns with capability negotiation: an unadvertised resource is
reported as not found.

```json
{
  "ok": false,
  "error": "routing trace is not supported by this engine"
}
```

## Result Semantics

- `matched` — the rule was evaluated and selected the outbound. First match
  terminates the decision, with one exception: a rule whose outbound is the
  literal `must_rules` (dae) reports `matched` but does not terminate the
  decision — the engine sets the evaluation-level `must` flag and keeps
  evaluating, and the outbound comes from a later matching rule or the
  fallback. `must_direct` / `must_groupname` (equivalently `direct(must)` /
  `groupname(must)`) terminate like any other rule and additionally set
  the `must` flag.
- `not_matched` — the rule was evaluated and did not match.
- `skipped` — the rule (or subcondition) was **not** evaluated, because an
  earlier rule already decided the flow or a sibling subcondition
  short-circuited the expression: for `a() && b()`, when `a()` is
  `not_matched`, `b()` is reported as `skipped`. A skipped step carries no
  verdict and must not be rendered as one.
- `indeterminate` — the rule was evaluated, but its verdict depends on an
  input the request did not provide. This is reported instead of guessing,
  so clients can show which inputs would sharpen the answer — for example
  a `pname()` rule when no process name is known, a `dport()` rule when no
  port is specified, or an `l4proto()` rule when no network is specified.
  `sport()`, `mac()` and `dscp()` rules have no corresponding query
  parameter and are therefore `indeterminate` whenever evaluated (or
  `skipped` when an earlier rule already decided the flow); `src` is
  exposed because source-IP rules are common in debugging, while source
  port, MAC and DSCP rarely are. Inputs derivable from provided ones are
  computed per evaluation — `ipversion()` derives from `ip` — and are
  `indeterminate` only in the `ip: null` resolution-failure case.
  An `indeterminate` rule does not terminate the decision; evaluation
  continues, and the dependency is captured by the evaluation-level
  `indeterminate` flag.

For subconditions, `matched` and `not_matched` describe the subexpression
alone; the rule-level outcome is the conjunction of its conditions. An
`indeterminate` condition does not short-circuit: the engine continues
evaluating sibling conditions. If any sibling is definitively
`not_matched`, the rule reports `not_matched` and does not set the
evaluation-level flag; if no condition is definitively `not_matched` and
at least one is `indeterminate`, the rule reports `indeterminate`.
dae-style rule sets express "or" as multiple rules with the same outbound
rather than a `||` operator; within one function call, multiple parameters
are also OR-ed.

## Worked Example: must_rules

For a rule set of `pname(mosdns) -> must_rules`, `dip(geoip:cn) -> direct`
and `fallback: mygroup`, tracing `?ip=8.8.8.8&pname=mosdns` produces one
evaluation (abridged):

```json
{
  "ip": "8.8.8.8",
  "steps": [
    { "index": 0, "rule": "pname(mosdns) -> must_rules", "result": "matched", "reason": null, "conditions": [] },
    { "index": 1, "rule": "dip(geoip:cn) -> direct", "result": "not_matched", "reason": null, "conditions": [] },
    { "index": 2, "rule": "fallback: mygroup", "result": "matched", "reason": null, "conditions": [] }
  ],
  "outbound": "mygroup",
  "indeterminate": false,
  "must": true,
  "mark": null
}
```

Evaluation continues after the `must_rules` match: the outbound comes from
the fallback, and `must: true` records that the flow's DNS traffic will not
be hijacked into the engine.

## Example

```bash
curl "http://localhost:9527/api/routing/trace?domain=example.com&port=443&network=tcp"
curl "http://localhost:9527/api/routing/trace?ip=1.1.1.1&pname=curl"
curl "http://localhost:9527/api/routing/trace?domain=example.com&ip=93.184.216.34"
```
