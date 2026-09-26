import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { once } from "node:events";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { parse } from "yaml";
import { createContract, renderExample, validateExample } from "./contract.mjs";
import { validateFlowTrace } from "./validate-flow.mjs";
import { checkContract } from "./check-contract.mjs";

const spec = parse(await readFile(new URL("../source/openapi.yaml", import.meta.url), "utf8"));
const contract = createContract(spec);

function example(key) {
  const value = contract.examples.get(key);
  assert.ok(value, `missing canonical example ${key}`);
  return structuredClone(value);
}

function assertValid(errors, label = "expected valid data") {
  assert.deepEqual(errors, [], label);
}

function assertInvalid(errors, label = "invalid data passed") {
  assert.ok(errors.length > 0, label);
}

function step(flow, stage, predicate = () => true) {
  const value = flow.trace.steps.find((candidate) => candidate.stage === stage && predicate(candidate.data));
  assert.ok(value, `missing ${stage} step`);
  return value;
}

function setPath(value, dottedPath, replacement) {
  const parts = dottedPath.split(".");
  const owner = parts.slice(0, -1).reduce((current, part) => current[part], value);
  owner[parts.at(-1)] = replacement;
}

test("the bundled contract and every named example are valid", () => {
  assertValid(contract.errors, "invalid bundled contract");
  for (const [key, value] of contract.examples) {
    assertValid(validateExample(contract, value), key);
  }
});

test("refined nullable objects stay open for client generators", () => {
  assert.deepEqual([
    spec.components.schemas.OperationCommon.properties.result.additionalProperties,
    spec.components.schemas.RouteStepData.properties.input.additionalProperties,
  ], [true, true]);
});

test("connection examples preserve totals and linked flow identity", () => {
  const connections = example("listConnections:200:visible").body;
  if (!connections.truncated) {
    assert.equal(connections.total_tcp, connections.tcp.length);
    assert.equal(connections.total_udp, connections.udp.length);
  }
  const connection = connections.tcp.find((entry) => entry.flow_id !== null);
  assert.ok(connection);
  const listed = example("listFlows:200:visible").body;
  const summary = listed.flows.find((flow) => flow.id === connection.flow_id);
  assert.ok(summary);
  const detail = example("getFlow:200:partial_handoff").body;
  assert.equal(listed.instance_id, connections.instance_id);
  for (const flow of [summary, detail]) {
    assert.equal(flow.id, connection.flow_id);
    assert.equal(flow.instance_id, connections.instance_id);
    assert.equal(flow.connection_id, connection.id);
    assert.equal(flow.started_at, connection.started_at);
  }
  assert.equal(detail.input.src, connection.src);
  assert.equal(detail.input.dst, connection.dst);
  assert.equal(detail.input.domain, connection.domain);
  const unrelated = example("getFlow:200:interleaved_dns").body;
  assert.notEqual(unrelated.id, detail.id);
  assert.notEqual(unrelated.connection_id, connection.id);
});

test("connection and flow-summary examples carry required list-view evidence", () => {
  const fields = ["chain", "chain_source", "rule_id", "rule_expression", "rule_source", "ingress", "domain_source"];
  const sources = {
    chain_source: ["evaluation", "reconstructed", "unknown"],
    rule_source: ["kernel", "recomputed", "unknown"],
  };
  const selectors = {
    listConnections: (body) => [...body.tcp, ...body.udp],
    listFlows: (body) => body.flows,
    getFlow: (body) => [body],
  };
  const seen = new Set();
  for (const response of contract.examples.values()) {
    const select = selectors[response.operationId];
    if (response.kind !== "response" || response.status !== 200 || !select) continue;
    const schema = { $ref: `#/components/schemas/${response.operationId === "listConnections" ? "Connection" : "FlowSummary"}` };
    for (const row of select(response.body)) {
      seen.add(response.operationId);
      for (const field of fields) {
        assert.ok(Object.hasOwn(row, field), `${response.id} ${row.id} lacks ${field}`);
        const missing = structuredClone(row);
        delete missing[field];
        assertInvalid(contract.validate(schema, missing), `${field} must be required`);
      }
      assert.ok(Array.isArray(row.chain) && row.chain.every((id) => typeof id === "string"));
      for (const [field, values] of Object.entries(sources)) {
        assert.ok(values.includes(row[field]), `${response.id} has invalid ${field}`);
        assertInvalid(contract.validate(schema, { ...row, [field]: "invalid" }));
      }
      assert.ok(["lan", "wan", null].includes(row.ingress));
      assert.ok(row.domain_source === null || spec.components.schemas.DomainSource.enum.includes(row.domain_source));
    }
  }
  assert.deepEqual([...seen].sort(), Object.keys(selectors).sort());
});

test("linked list evidence agrees with the application flow rather than DNS attempts", () => {
  const connection = example("listConnections:200:visible").body.tcp[0];
  const summary = example("listFlows:200:visible").body.flows[0];
  const detail = example("getFlow:200:partial_handoff").body;
  for (const field of ["chain", "chain_source", "rule_id", "rule_expression", "rule_source", "ingress", "domain_source"]) {
    assert.deepEqual(connection[field], summary[field], field);
    assert.deepEqual(summary[field], detail[field], field);
  }
  for (const key of ["getFlow:200:partial_handoff", "getFlow:200:interleaved_dns"]) {
    const flow = example(key).body;
    const outbound = step(flow, "outbound", (data) => data.target === flow.input.domain + ":443").data;
    assert.deepEqual(flow.chain, [...outbound.selection_path.map((item) => item.group_id), outbound.leaf_node_id]);
    assert.equal(flow.ingress, flow.input.ingress);
    assert.equal(flow.domain_source, flow.input.domain_source);
    const route = step(flow, "route", (data) => data.evaluation_id === outbound.evaluation_id).data;
    assert.equal(flow.rule_id, route.rule_id);
  }
});

test("outbound counters retain uint64 totals and a numeric active count", () => {
  const response = example("getRuntimeOutbounds:200:snapshot");
  const row = response.body.outbounds[0];
  for (const field of ["total_connections", "upload_bytes", "download_bytes", "errors"]) {
    row[field] = "18446744073709551615";
    assertValid(validateExample(contract, response));
    row[field] = 0;
    assertInvalid(validateExample(contract, response), `${field} accepted a JSON number`);
    row[field] = "0";
  }
  row.active_connections = 9007199254740991;
  assertValid(validateExample(contract, response));
  row.active_connections = "0";
  assertInvalid(validateExample(contract, response));
  row.active_connections = 0;
  row.kind = "invalid";
  assertInvalid(validateExample(contract, response));
  row.kind = "builtin";
  delete response.body.counter_since;
  assertInvalid(validateExample(contract, response));
});

test("traffic history preserves gaps, timestamps, and safe numeric boundaries", () => {
  const response = example("getTrafficHistory:200:recent");
  const sample = response.body.samples[0];
  sample.upload_bytes_per_second = null;
  sample.download_bytes_per_second = null;
  sample.connections = null;
  assertValid(validateExample(contract, response));
  sample.upload_bytes_per_second = "18446744073709551615";
  sample.download_bytes_per_second = "18446744073709551615";
  sample.connections = 9007199254740991;
  assertValid(validateExample(contract, response));
  for (const field of ["upload_bytes_per_second", "download_bytes_per_second", "connections"]) {
    const valid = sample[field];
    sample[field] = field === "connections" ? "0" : 0;
    assertInvalid(validateExample(contract, response), `${field} accepted the wrong numeric type`);
    sample[field] = valid;
  }
  delete sample.sampled_at;
  assertInvalid(validateExample(contract, response));
  response.body.samples = [];
  assertValid(validateExample(contract, response));
  response.body.sampled_every_seconds = 0;
  assertInvalid(validateExample(contract, response));
});

test("traffic history advertises usable limits and rejects invalid query shapes", () => {
  const capabilities = example("getCapabilities:200:available");
  const limits = capabilities.body.resources.traffic_history;
  assert.equal(typeof capabilities.body.resources.runtime_outbounds.available, "boolean");
  assert.equal(limits.available, true);
  for (const field of ["max_window_seconds", "max_points"]) {
    const value = limits[field];
    delete limits[field];
    assertInvalid(validateExample(contract, capabilities), `${field} must be advertised when available`);
    limits[field] = 0;
    assertInvalid(validateExample(contract, capabilities));
    limits[field] = value;
  }
  const request = example("getTrafficHistory:request");
  for (const name of ["window_seconds", "max_points"]) {
    const parameter = request.parameters.find((item) => item.definition.name === name);
    assert.ok(parameter, `missing ${name} query parameter`);
    const value = parameter.value;
    parameter.value = 0;
    assertInvalid(validateExample(contract, request));
    parameter.value = value;
  }
  const history = example("getTrafficHistory:200:recent").body;
  assert.ok(history.window_seconds <= limits.max_window_seconds);
  assert.ok(history.samples.length <= limits.max_points);
  for (const key of ["window_too_large", "too_many_points"]) {
    const rejected = example(`getTrafficHistory:400:${key}`);
    assert.equal(rejected.body.error.code, "invalid_request");
    assertValid(validateExample(contract, rejected));
  }
});

test("runtime settings stay inside their capability ceilings and advertised fields", () => {
  const capabilities = example("getCapabilities:200:available");
  const resources = capabilities.body.resources;
  assert.equal(resources.runtime_settings.available, true);
  delete resources.runtime_settings.fields;
  assertInvalid(validateExample(contract, capabilities), "fields must be advertised when available");
  resources.runtime_settings.fields = ["log.level"];
  assertValid(validateExample(contract, capabilities));
  resources.runtime_settings.fields = ["log.colour"];
  assertInvalid(validateExample(contract, capabilities), "fields come from the enum");
  const current = example("getRuntimeSettings:200:current").body;
  assert.ok(resources.logs.levels.includes(current.log.level));
  assert.ok(current.log.buffered_records <= resources.logs.max_buffered_records);
  assert.ok(current.dns_log.max_records <= resources.dns_log.max_records);
  assert.ok(current.flows.max_flows <= resources.flows.max_flows);
  assert.ok(current.flows.retention_seconds <= resources.flows.retention_seconds);
  const patch = example("patchRuntimeSettings:request:debug");
  assertValid(validateExample(contract, patch));
  patch.body = {};
  assertInvalid(validateExample(contract, patch), "an empty patch is rejected");
  patch.body = {log: {level: "verbose"}};
  assertInvalid(validateExample(contract, patch), "levels come from the enum");
  patch.body = {source: "runtime"};
  assertInvalid(validateExample(contract, patch), "source is read-only");
  patch.body = {dns_log: {max_records: 63}};
  assertInvalid(validateExample(contract, patch), "rings keep at least 64 records");
  const rejected = example("patchRuntimeSettings:400:above_ceiling");
  assert.equal(rejected.body.error.code, "invalid_request");
  assertValid(validateExample(contract, rejected));
});

test("geodata sources are patched through runtime settings and reported with their status", () => {
  const resources = example("getCapabilities:200:available").body.resources;
  assert.equal(resources.geodata.configurable_sources, true);
  assert.ok(resources.runtime_settings.fields.includes("geodata"));
  for (const key of ["current", "config_sources"]) {
    const settings = example(`getRuntimeSettings:200:${key}`);
    assertValid(validateExample(contract, settings));
    settings.body.geodata.auto_update.interval_hours = 5;
    assertInvalid(validateExample(contract, settings), "the interval is at least 6 hours");
  }
  const stored = example("patchRuntimeSettings:200:geodata_stored").body.geodata;
  assert.equal(stored.source, "db");
  const patch = example("patchRuntimeSettings:request:geodata_sources");
  assertValid(validateExample(contract, patch));
  assert.deepEqual(stored.geosite.urls, patch.body.geodata.geosite.urls);
  assertValid(validateExample(contract, example("patchRuntimeSettings:request:geodata_reset")));
  const autoUpdate = example("patchRuntimeSettings:request:geodata_auto_update");
  assertValid(validateExample(contract, autoUpdate));
  assert.deepEqual(Object.keys(autoUpdate.body.geodata), ["auto_update"], "auto_update is patchable on its own");
  assert.deepEqual(example("getRuntimeSettings:200:config_sources").body.geodata.auto_update,
    autoUpdate.body.geodata.auto_update);
  const autoDefaults = spec.components.schemas.GeoDataAutoUpdate.properties;
  assert.deepEqual(example("getRuntimeSettings:200:current").body.geodata.auto_update,
    {enabled: autoDefaults.enabled.default, interval_hours: autoDefaults.interval_hours.default},
    "the built-in settings show the defaults");
  assert.equal(autoDefaults.enabled.default, true, "automatic updates are on by default");
  const downloadDefault = spec.components.schemas.GeoDataSettings.properties.download.default;
  assert.deepEqual(downloadDefault, {route: "routing", group_id: null}, "downloads follow routing by default");
  assert.deepEqual(example("getRuntimeSettings:200:current").body.geodata.download, downloadDefault,
    "the built-in settings show the default route");
  patch.body = {geodata: {geosite: {urls: ["http://mirror.example.net/geosite.dat"]}}};
  assertValid(validateExample(contract, patch), "plain http is accepted");
  for (const [geodata, label] of [
    [{source: "db"}, "source is read-only"],
    [{geosite: {urls: []}}, "a URL list is never empty"],
    [{geosite: {urls: ["ftp://mirror.example.net/geosite.dat"]}}, "URLs are HTTP(S)"],
    [{geosite: {urls: ["https://user@mirror.example.net/geosite.dat"]}}, "URLs carry no userinfo"],
    [{geosite: {urls: ["https://mirror.example.net/geosite.dat#x"]}}, "URLs carry no fragment"],
    [{geosite: {urls: Array.from({length: 5}, (_, i) => `https://m${i}.example.net/geosite.dat`)}}, "at most 4 URLs"],
    [{auto_update: {interval_hours: 169}}, "the interval is at most 168 hours"],
    [{auto_update: {}}, "an empty auto_update is rejected"],
    [{download: {route: "group"}}, "route group names its group"],
    [{download: {route: "direct", group_id: "group-proxy"}}, "only route group takes a group_id"],
    [{download: {route: "proxy"}}, "the route is routing, group or direct"],
  ]) {
    patch.body = {geodata};
    assertInvalid(validateExample(contract, patch), label);
  }
  const download = example("patchRuntimeSettings:request:geodata_download");
  assertValid(validateExample(contract, download));
  assert.deepEqual(Object.keys(download.body.geodata), ["download"], "download is patchable on its own");
  patch.body = {geodata: {download: {route: "routing"}}};
  assertValid(validateExample(contract, patch), "routing needs no group");
  assert.ok(spec.paths["/api/v1/runtime/settings"].patch.responses["422"], "an unknown group is rejected");
  const noRoute = example("getRuntimeSettings:200:current");
  delete noRoute.body.geodata.download;
  assertInvalid(validateExample(contract, noRoute), "the settings report the download route");
  assert.equal(spec.paths["/api/v1/runtime/settings"].patch.responses["409"], undefined,
    "URL patches are accepted under any source");
  const seeded = example("getRuntimeSettings:200:config_sources");
  seeded.body.geodata.geoip.urls = [];
  assertInvalid(validateExample(contract, seeded), "a stored URL list is never empty");
  for (const key of ["loaded", "packaged"]) {
    const status = example(`getGeoData:200:${key}`);
    assertValid(validateExample(contract, status));
    for (const field of ["next_check_at", "required_codes"]) {
      const saved = status.body[field];
      delete status.body[field];
      assertInvalid(validateExample(contract, status), `${field} is reported with the other status fields`);
      status.body[field] = saved;
    }
    const asset = status.body.assets[0];
    delete asset.verified;
    assertInvalid(validateExample(contract, status), "verified is reported with fetched_url_redacted");
    asset.verified = asset.fetched_url_redacted !== null;
    assertValid(validateExample(contract, status));
    const route = asset.download_route;
    delete asset.download_route;
    assertInvalid(validateExample(contract, status), "download_route is reported with fetched_url_redacted");
    asset.download_route = route;
    status.body.required_codes = {geodns: []};
    assertInvalid(validateExample(contract, status), "required_codes is keyed by asset kind");
  }
  const legacy = example("getGeoData:200:loaded");
  for (const field of ["last_checked_at", "last_updated_at", "next_check_at", "last_error", "required_codes"]) {
    delete legacy.body[field];
  }
  for (const asset of legacy.body.assets) {
    delete asset.fetched_url_redacted;
    delete asset.verified;
    delete asset.download_route;
  }
  assertValid(validateExample(contract, legacy), "backends without configurable sources stay valid");
});

test("DNS log records keep client evidence and page inside the advertised size", () => {
  const capabilities = example("getCapabilities:200:available");
  const log = capabilities.body.resources.dns_log;
  assert.equal(log.available, true);
  for (const field of ["max_records", "max_page_size"]) {
    const value = log[field];
    delete log[field];
    assertInvalid(validateExample(contract, capabilities), `${field} must be advertised when available`);
    log[field] = value;
  }
  const page = example("listDnsLog:200:recent");
  assertValid(validateExample(contract, page));
  assert.ok(page.body.records.length <= log.max_page_size);
  const [live, cached] = page.body.records;
  assert.equal(cached.cached, true);
  assert.equal(cached.upstream, null);
  assert.match(cached.src, /^\[[0-9a-f:]+\]:\d+$/);
  assert.ok(live.answers.length > 0);
  live.src = null;
  assertValid(validateExample(contract, page));
  delete live.route;
  assertInvalid(validateExample(contract, page), "the routing decision is part of the record");
});

test("memory history mirrors traffic history: gaps, uint64 boundaries, limits and query shapes", () => {
  const response = example("getMemoryHistory:200:recent");
  const sample = response.body.samples[0];
  sample.rss_bytes = null;
  sample.cgroup_current_bytes = null;
  delete sample.kernel_ebpf_bytes;
  assertValid(validateExample(contract, response));
  sample.rss_bytes = "18446744073709551615";
  sample.cgroup_current_bytes = "18446744073709551615";
  assertValid(validateExample(contract, response));
  for (const field of ["rss_bytes", "cgroup_current_bytes"]) {
    const valid = sample[field];
    sample[field] = 0;
    assertInvalid(validateExample(contract, response), `${field} accepted a JSON number`);
    delete sample[field];
    assertInvalid(validateExample(contract, response), `${field} is required`);
    sample[field] = valid;
  }
  delete sample.sampled_at;
  assertInvalid(validateExample(contract, response));
  response.body.samples = [];
  assertValid(validateExample(contract, response));
  response.body.sampled_every_seconds = 0;
  assertInvalid(validateExample(contract, response));

  const capabilities = example("getCapabilities:200:available");
  const limits = capabilities.body.resources.memory_history;
  assert.equal(limits.available, true);
  for (const field of ["max_window_seconds", "max_points"]) {
    const value = limits[field];
    delete limits[field];
    assertInvalid(validateExample(contract, capabilities), `${field} must be advertised when available`);
    limits[field] = value;
  }
  const request = example("getMemoryHistory:request");
  for (const name of ["window_seconds", "max_points"]) {
    const parameter = request.parameters.find((item) => item.definition.name === name);
    assert.ok(parameter, `missing ${name} query parameter`);
    const value = parameter.value;
    parameter.value = 0;
    assertInvalid(validateExample(contract, request));
    parameter.value = value;
  }
  const history = example("getMemoryHistory:200:recent").body;
  assert.ok(history.window_seconds <= limits.max_window_seconds);
  assert.ok(history.samples.length <= limits.max_points);
  for (const key of ["window_too_large", "too_many_points"]) {
    const rejected = example(`getMemoryHistory:400:${key}`);
    assert.equal(rejected.body.error.code, "invalid_request");
    assertValid(validateExample(contract, rejected));
  }
  assert.equal(example("getDiscovery:200:draft").body.links.memory_history, "/api/v1/runtime/memory/history");
});

test("effective configuration preserves opaque revisions and source metadata types", () => {
  const response = example("getConfig:200:redacted");
  response.body.revision = "revision:not-a-number";
  response.body.sources[0].content = "";
  response.body.extension = { supported: true };
  assertValid(validateExample(contract, response));
  for (const [field, invalid] of [
    ["content_sha256", "sha256:not-a-digest"],
    ["bytes", "128"],
    ["line_count", -1],
    ["loaded_at", "yesterday"],
    ["kind", "remote"],
    ["writable", "true"],
  ]) {
    const changed = example("getConfig:200:redacted");
    changed.body.sources[0][field] = invalid;
    assertInvalid(validateExample(contract, changed), `invalid ${field} passed`);
  }
  delete response.body.revision;
  assertInvalid(validateExample(contract, response));
});

test("both configuration results allow unknown locations but reject zero-based positions", () => {
  for (const key of ["getConfig:200:redacted", "validateConfig:200:invalid"]) {
    const response = example(key);
    const diagnostic = response.body.diagnostics[0];
    diagnostic.code = "adapter_specific_diagnostic";
    diagnostic.line = null;
    diagnostic.column = null;
    diagnostic.span = null;
    assertValid(validateExample(contract, response));
    diagnostic.line = 0;
    assertInvalid(validateExample(contract, response));
    diagnostic.line = 1;
    diagnostic.column = 0;
    assertInvalid(validateExample(contract, response));
    diagnostic.column = 1;
    diagnostic.span = { start_line: 1, start_column: 1, end_line: 1, end_column: 1 };
    assertValid(validateExample(contract, response));
    delete diagnostic.span.end_column;
    assertInvalid(validateExample(contract, response));
  }
});

test("validation validity distinguishes errors from warnings and info", () => {
  const response = example("validateConfig:200:invalid");
  response.body.valid = true;
  assertInvalid(validateExample(contract, response), "errors cannot be valid");
  for (const level of ["warning", "info"]) {
    response.body.diagnostics[0].level = level;
    assertValid(validateExample(contract, response));
  }
  response.body.valid = false;
  assertInvalid(validateExample(contract, response), "invalid candidates need an error diagnostic");
  response.body.diagnostics = [];
  assertInvalid(validateExample(contract, response));
  response.body.valid = true;
  assertValid(validateExample(contract, response));
});

test("validation accepts unnamed and empty text candidates but closes request objects", () => {
  const request = example("validateConfig:request:syntax_error");
  request.body.sources = [{ content: "" }];
  assertValid(validateExample(contract, request));
  request.body.mode = "full";
  request.body.sources[0].path = "<redacted>";
  assertValid(validateExample(contract, request));
  request.body.sources[0].apply = true;
  assertInvalid(validateExample(contract, request));
  delete request.body.sources[0].apply;
  request.body.apply = true;
  assertInvalid(validateExample(contract, request));
  delete request.body.apply;
  request.body.mode = "live";
  assertInvalid(validateExample(contract, request));
  request.body.mode = "syntax";
  request.body.sources = [];
  assertInvalid(validateExample(contract, request));
});

test("configuration capabilities require usable limits only when available", () => {
  for (const [resource, fields] of [
    ["config", ["content", "writable", "max_bytes", "max_sources"]],
    ["config_validate", ["modes", "max_bytes", "max_sources"]],
  ]) {
    const response = example("getCapabilities:200:available");
    for (const field of fields) {
      const changed = structuredClone(response);
      delete changed.body.resources[resource][field];
      assertInvalid(validateExample(contract, changed), `missing ${resource}.${field} passed`);
      if (field.startsWith("max_")) {
        for (const invalid of [0, 9007199254740992]) {
          changed.body.resources[resource][field] = invalid;
          assertInvalid(validateExample(contract, changed));
        }
      }
    }
    response.body.resources[resource] = { available: false };
    assertValid(validateExample(contract, response));
    delete response.body.resources[resource];
    assertInvalid(validateExample(contract, response), "unavailable resource keys must still be present");
  }
  const response = example("getCapabilities:200:available");
  for (const modes of [[], ["syntax", "syntax"], ["live"]]) {
    response.body.resources.config_validate.modes = modes;
    assertInvalid(validateExample(contract, response));
  }
});

test("configuration examples obey visibility, runtime identity, and advertised limits", () => {
  const resources = example("getCapabilities:200:available").body.resources;
  const runtime = example("getRuntime:200:snapshot").body;
  const config = example("getConfig:200:redacted").body;
  assert.equal(config.generation_id, runtime.generation.active_id);
  assert.equal(config.revision, runtime.generation.config_revision);
  assert.ok(config.sources.length <= resources.config.max_sources);
  for (const source of config.sources) {
    if (!resources.config.content) {
      assert.equal(Object.hasOwn(source, "content"), false);
      assert.equal(config.secrets_redacted, true);
    }
    assert.ok(Date.parse(source.loaded_at) >= Date.parse(runtime.lifecycle.started_at));
  }
  for (const value of contract.examples.values()) {
    if (value.operationId !== "validateConfig") continue;
    if (value.kind === "request") {
      assert.ok(resources.config_validate.modes.includes(value.body.mode));
      assert.ok(value.body.sources.length <= resources.config_validate.max_sources);
      const bytes = value.body.sources.reduce((sum, source) => sum + Buffer.byteLength(source.content, "utf8"), 0);
      assert.ok(bytes <= resources.config_validate.max_bytes);
    } else if (value.status === 200) {
      assert.equal(value.body.generation_id, runtime.generation.active_id);
      assert.ok(Date.parse(value.body.validated_at) >= Date.parse(runtime.generation.activated_at));
    }
  }
  const request = example("validateConfig:request:syntax_error").body;
  const result = example("validateConfig:200:invalid").body;
  for (const diagnostic of result.diagnostics) {
    assert.ok(request.sources.some((source, index) => (source.id ?? `source-${index + 1}`) === diagnostic.source_id));
  }
  for (const name of ["too_many_bytes", "too_many_sources"]) {
    const rejected = example(`validateConfig:413:${name}`);
    assert.equal(rejected.body.error.code, "request_too_large");
    assertValid(validateExample(contract, rejected));
  }
});
test("source editing examples preserve exact bytes and use the accepted hash as a precondition", () => {
  const snapshot = example("getConfig:200:editable").body;
  const source = example("getConfigSource:200:editable").body;
  const request = example("replaceConfigSource:request:replacement");
  assert.deepEqual(source, snapshot.sources.find(({ id }) => id === source.id));
  assert.equal(createHash("sha256").update(source.content, "utf8").digest("hex"), source.content_sha256);
  assert.equal(Buffer.byteLength(source.content, "utf8"), source.bytes);
  assert.equal(request.parameters.find(({ definition }) => definition.name === "source_id").value, source.id);
  assert.equal(request.headers["If-Match"], `"${source.content_sha256}"`);
  assert.equal(
    createHash("sha256").update(request.body.content, "utf8").digest("hex"),
    "92fe71cacbc73458f2da2a62363cec2e1cfae3ee0e3838acd7a90562e64f242a",
  );
  assert.ok(Buffer.byteLength(request.body.content, "utf8") <=
    example("getCapabilities:200:available").body.resources.config.max_bytes);
  assert.match(renderExample(request, "http"), /^PUT \/api\/v1\/config\/sources\/source-main HTTP\/1\.1/m);
});

test("source replacement accepts only complete text with a single hash precondition", () => {
  const request = example("replaceConfigSource:request:replacement");
  request.body.content = "";
  assertValid(validateExample(contract, request));
  for (const body of [{}, { content: null }, { content: "", path: "other.dae" },
    { content: "", mode: "syntax" }, { sources: [{ content: "" }] }, [{ op: "replace", path: "/content", value: "" }]]) {
    const changed = structuredClone(request);
    changed.body = body;
    assertInvalid(validateExample(contract, changed));
  }
  const missing = structuredClone(request);
  delete missing.headers["If-Match"];
  assertInvalid(validateExample(contract, missing));
  for (const value of ["*", `W/${request.headers["If-Match"]}`, '"17"', request.headers["If-Match"].slice(1, -1),
    `${request.headers["If-Match"]}, ${request.headers["If-Match"]}`]) {
    const changed = structuredClone(request);
    changed.headers["If-Match"] = value;
    assertInvalid(validateExample(contract, changed));
  }
});

test("source readback permits withheld text but never advertises writable engine output", () => {
  const source = example("getConfigSource:200:redacted");
  assert.equal(Object.hasOwn(source.body, "content"), false);
  assertValid(validateExample(contract, source));
  for (const kind of ["subscription", "generated"]) {
    source.body.kind = kind;
    source.body.writable = false;
    assertValid(validateExample(contract, source));
    source.body.writable = true;
    assertInvalid(validateExample(contract, source));
  }
  delete source.body.writable;
  assertInvalid(validateExample(contract, source));
  const unavailable = example("getConfigSource:404:resource_not_found");
  assert.equal(unavailable.body.error.code, "resource_not_found");
  assertValid(validateExample(contract, unavailable));
});

test("rejected source writes carry structured errors without pretending validation succeeded", () => {
  for (const [status, name, code] of [
    [403, "permission_denied", "permission_denied"],
    [412, "stale_revision", "stale_revision"],
    [428, "precondition_required", "precondition_required"],
  ]) {
    const response = example(`replaceConfigSource:${status}:${name}`);
    assert.equal(response.body.error.code, code);
    assertValid(validateExample(contract, response));
  }
  const rejected = example("replaceConfigSource:422:invalid");
  assert.equal(rejected.body.error.code, "unsupported_value");
  assert.equal(rejected.body.error.details.diagnostics[0].source_id,
    example("getConfigSource:200:editable").body.id);
  for (const mutate of [
    (body) => { delete body.request_id; },
    (body) => { delete body.error.details; },
    (body) => { body.error.details.diagnostics = []; },
    (body) => { body.error.details.diagnostics[0].level = "warning"; },
    (body) => { body.error.details.diagnostics[0].column = 0; },
    (body) => { body.error.code = "invalid_request"; },
  ]) {
    const changed = structuredClone(rejected);
    mutate(changed.body);
    assertInvalid(validateExample(contract, changed));
  }
});

test("source writes accept only reload operations with causal polling headers", () => {
  const accepted = example("replaceConfigSource:202:queued");
  assert.equal(accepted.body.kind, "reload");
  assertValid(validateExample(contract, accepted));
  for (const mutate of [
    (value) => { value.body.kind = "group_update"; },
    (value) => { value.body.status = "succeeded"; },
    (value) => { delete value.headers.Location; },
    (value) => { value.headers.Location = "/api/v1/operations/other"; },
    (value) => { delete value.headers["Retry-After"]; },
    (value) => { value.headers["Retry-After"] = 0; },
  ]) {
    const changed = structuredClone(accepted);
    mutate(changed);
    assertInvalid(validateExample(contract, changed));
  }
});

test("rejected-write diagnostics retain ordered source coordinates", () => {
  const changed = structuredClone(spec);
  const diagnostic = changed.paths["/api/v1/config/sources/{source_id}"].put.responses["422"]
    .content["application/json"].examples.invalid.value.error.details.diagnostics[0];
  diagnostic.span.end_column = diagnostic.span.start_column - 1;
  assert.ok(checkContract(changed).errors.some((error) => /span ends before/.test(error)));
  diagnostic.span.end_column = diagnostic.span.start_column;
  diagnostic.column += 1;
  assert.ok(checkContract(changed).errors.some((error) => /location differs/.test(error)));
});


test("configuration checker rejects duplicate source IDs and dangling diagnostic references", () => {
  for (const [mutate, message] of [
    [(body) => body.sources.push({ ...body.sources[0], path: "<redacted-include>" }), /duplicate source ID/],
    [(body) => { body.diagnostics[0].source_id = "absent"; }, /unknown diagnostic source/],
  ]) {
    const changed = structuredClone(spec);
    mutate(changed.paths["/api/v1/config"].get.responses["200"].content["application/json"].examples.redacted.value);
    assert.ok(checkContract(changed).errors.some((error) => message.test(error)));
  }
  const changed = structuredClone(spec);
  changed.paths["/api/v1/config/validate"].post.requestBody.content["application/json"].examples.full.value.sources =
    [{ id: "source-2", content: "" }, { content: "" }];
  assert.ok(checkContract(changed).errors.some((error) => /duplicate source ID source-2/.test(error)));
});

test("configuration checker preserves ordered spans and their point locations", () => {
  const changed = structuredClone(spec);
  const diagnostic = changed.paths["/api/v1/config/validate"].post.responses["200"]
    .content["application/json"].examples.invalid.value.diagnostics[0];
  diagnostic.span.end_column = diagnostic.span.start_column;
  assertValid(checkContract(changed).errors, "zero-width span rejected");
  diagnostic.span.end_line = 2;
  diagnostic.span.end_column = 1;
  assertValid(checkContract(changed).errors, "multiline span rejected");
  diagnostic.span.end_line = 1;
  assert.ok(checkContract(changed).errors.some((error) => /span ends before/.test(error)));
  diagnostic.span.end_column = 9;
  diagnostic.column = 7;
  assert.ok(checkContract(changed).errors.some((error) => /location differs/.test(error)));
});

test("examples remain bound to their operation schema", () => {
  const changed = structuredClone(spec);
  changed.paths["/api/v1/flows/{flow_id}"].get.responses["200"].content[
    "application/json"
  ].schema = { $ref: "#/components/schemas/Runtime" };
  assertInvalid(createContract(changed).errors);
});

test("required path, query, and header parameters need native examples", () => {
  const mutations = [
    (changed) => delete changed.components.parameters.FlowId.example,
    (changed) => {
      const parameter = changed.paths["/api/v1/dns/query"].get.parameters.find(
        (candidate) => candidate.name === "domain",
      );
      assert.ok(parameter);
      delete parameter.example;
    },
    (changed) => delete changed.components.parameters.IfMatch.example,
  ];

  for (const mutate of mutations) {
    const changed = structuredClone(spec);
    mutate(changed);
    assertInvalid(createContract(changed).errors);
  }
});

test("unsupported parameter serialization is rejected explicitly", () => {
  const changed = structuredClone(spec);
  const parameter = changed.paths["/api/v1/dns/query"].get.parameters.find(
    (candidate) => candidate.name === "domain",
  );
  assert.ok(parameter);
  parameter.style = "deepObject";
  assertInvalid(createContract(changed).errors);
});

test("required request headers are checked case-insensitively", () => {
  const missing = example("patchGroup:request:tolerance");
  delete missing.headers["If-Match"];
  assertInvalid(validateExample(contract, missing));

  const lowerCase = example("patchGroup:request:tolerance");
  lowerCase.headers["if-match"] = lowerCase.headers["If-Match"];
  delete lowerCase.headers["If-Match"];
  assertValid(validateExample(contract, lowerCase));
});

test("202 response headers must be declared, present, typed, and causal", () => {
  const undeclared = structuredClone(spec);
  delete undeclared.paths["/api/v1/probes"].post.responses["202"].headers["Retry-After"];
  assertInvalid(createContract(undeclared).errors, "missing Retry-After declaration passed");

  const missing = example("createProbe:202:queued");
  delete missing.headers["Retry-After"];
  assertInvalid(validateExample(contract, missing), "missing Retry-After value passed");
  assert.throws(() => renderExample(missing, "http"));

  const wrongType = example("createProbe:202:queued");
  wrongType.headers["Retry-After"] = "1";
  assertInvalid(validateExample(contract, wrongType), "string Retry-After passed");

  const wrongLocation = example("createProbe:202:queued");
  wrongLocation.headers.Location = "/api/v1/operations/different-operation";
  assertInvalid(validateExample(contract, wrongLocation), "unrelated Location passed");
});

test("probe queue-full responses require a positive Retry-After", () => {
  const response = example("createProbe:503:queue_full");
  assertValid(validateExample(contract, response));
  assert.match(renderExample(response, "http"), /^HTTP\/1\.1 503 Service Unavailable\n/u);

  const missing = structuredClone(response);
  delete missing.headers["Retry-After"];
  assertInvalid(validateExample(contract, missing));
  assert.throws(() => renderExample(missing, "http"));

  const zero = structuredClone(response);
  zero.headers["Retry-After"] = 0;
  assertInvalid(validateExample(contract, zero));
});

test("snapshot_unavailable is a retryable 503 wherever a snapshot can fail", () => {
  for (const operationId of ["listNodes", "listProviders", "listRules", "traceRouting"]) {
    const response = example(`${operationId}:503:snapshot_unavailable`);
    assertValid(validateExample(contract, response));
    assert.equal(response.body.error.code, "snapshot_unavailable");
    assert.ok(response.headers["Retry-After"] >= 1, `${operationId} lacks Retry-After`);
  }
  for (const operationId of ["listNodes", "listProviders", "listRules", "traceRouting"]) {
    const missing = example(`${operationId}:503:snapshot_unavailable`);
    delete missing.headers["Retry-After"];
    assertInvalid(validateExample(contract, missing), `${operationId} Retry-After was optional`);
  }
  assert.equal(spec.paths["/api/v1/rules"].get.responses["409"], undefined);
  assert.equal(spec.paths["/api/v1/routing/trace"].post.responses["409"], undefined);
});

test("connection closing documents 503 and bulk close reports what it already closed", () => {
  assertValid(validateExample(contract, example("closeConnection:503:temporarily_unavailable")));
  const response = example("closeConnections:503:incomplete");
  assertValid(validateExample(contract, response));
  assert.ok(response.headers["Retry-After"] >= 1);
  for (const mutate of [
    (value) => { value.body.error.details = null; },
    (value) => { delete value.body.error.details.closed; },
    (value) => { value.body.error.details.closed = "2"; },
  ]) {
    const invalid = structuredClone(response);
    mutate(invalid);
    assertInvalid(validateExample(contract, invalid));
  }
});

test("the Location of a created node can be read back", () => {
  const created = example("createNode:201:created");
  const read = example("getNode:200:node");
  assertValid(validateExample(contract, read));
  assert.equal(created.headers.Location, `/api/v1/nodes/${read.body.id}`);
  assert.deepEqual(read.body, created.body);
  example("getNode:404:resource_not_found");
});

test("response status and media type cannot be rebound", () => {
  const wrongStatus = example("createProbe:202:queued");
  wrongStatus.status = 200;
  assertInvalid(validateExample(contract, wrongStatus));

  const wrongMedia = example("createProbe:202:queued");
  wrongMedia.mediaType = "text/plain";
  assertInvalid(validateExample(contract, wrongMedia));
});

test("an ordinary response property named schema is not contract metadata", () => {
  const response = example("getRuntime:200:snapshot");
  response.body.schema = { future_adapter: true };
  assertValid(validateExample(contract, response));
});

test("SSE event names select their authoritative payload schema", () => {
  const event = example("event:FlowUpdated");

  const wrongBinding = structuredClone(event);
  wrongBinding.event = "flow.gap";
  assertInvalid(validateExample(contract, wrongBinding), "event/schema binding mismatch passed");

  const flowGap = {
    instance_id: "instance-7",
    observed_at: "2026-09-14T10:00:00Z",
    resource_id: null,
    reason: "buffer_overflow",
    dropped_records: "1",
  };
  const flowGapSchema = spec.paths["/api/v1/events"].get.responses["200"].content[
    "text/event-stream"
  ]["x-event-data-schemas"]["flow.gap"];
  assertValid(contract.validate({ $ref: flowGapSchema }, flowGap));

  const wrongPayload = structuredClone(event);
  wrongPayload.body = flowGap;
  assertInvalid(validateExample(contract, wrongPayload), "wrong selected payload passed");
});

test("rendering rejects header and SSE field injection", () => {
  const response = example("createProbe:202:queued");
  response.headers.Location += "\r\nInjected: true";
  assert.throws(() => renderExample(response, "http"));

  const badEvent = example("event:FlowUpdated");
  badEvent.event += "\nevent: flow.gap";
  assert.throws(() => renderExample(badEvent, "http"));

  const badId = example("event:FlowUpdated");
  badId.eventId += "\r\nretry: 0";
  assert.throws(() => renderExample(badId, "http"));

  const nulId = example("event:FlowUpdated");
  nulId.eventId += "\u0000ignored";
  assertInvalid(validateExample(contract, nulId));
  assert.throws(() => renderExample(nulId, "sse"));
});

test("JSON and HTTP renderers expose the canonical wire values", () => {
  const body = example("createProbe:request:dns_udp");
  assert.deepEqual(JSON.parse(renderExample(body)), body.body);

  const query = renderExample(example("queryDns:request"), "http");
  assert.match(query, /^GET \/api\/v1\/dns\/query\?/u);
  assert.match(query, /(?:\?|&)domain=example\.com(?:&| )/u);
  assert.match(query, /(?:\?|&)type=A&type=AAAA(?:&| )/u);

  const pathRequest = renderExample(example("getFlow:request"), "http");
  assert.match(pathRequest, /^GET \/api\/v1\/flows\/flow-23 HTTP\/1\.1(?:\r?\n|$)/u);

  const accepted = renderExample(example("createProbe:202:queued"), "http");
  assert.match(accepted, /^HTTP\/1\.1 202 Accepted(?:\r?\n)/u);
  assert.match(accepted, /(?:^|\r?\n)Location: \/api\/v1\/operations\/op-01HZX4K8W9(?:\r?\n)/u);
  assert.match(accepted, /(?:^|\r?\n)Retry-After: 1(?:\r?\n)/u);
  assert.match(accepted, /\r?\n\r?\n/u);
});

test("native EventSource observes emitted and legal alternate SSE framing", { timeout: 3_000 }, async () => {
  assert.equal(typeof EventSource, "function", "run Node with --experimental-eventsource");
  const event = example("event:FlowUpdated");
  const emitted = renderExample(event, "http");
  assert.equal(
    emitted,
    `id: ${event.eventId}\nevent: ${event.event}\ndata: ${JSON.stringify(event.body)}\n\n`,
  );

  const lateEvent = `data:${JSON.stringify(event.body)}\nevent:${event.event}\nid: late\n\n`;
  const multiData = [
    `event: ${event.event}`,
    "id: multiline",
    ...JSON.stringify(event.body, null, 2)
      .split("\n")
      .map((line, index) => `data:${index % 2 ? " " : ""}${line}`),
    "",
    "",
  ].join("\r\n");

  const server = createServer((_request, response) => {
    response.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "close",
    });
    response.end(emitted + lateEvent + multiData);
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");

  let source;
  try {
    const address = server.address();
    assert.notEqual(address, null);
    source = new EventSource(`http://127.0.0.1:${address.port}/events`);
    const received = await new Promise((resolve, reject) => {
      const values = [];
      const timer = setTimeout(() => reject(new Error("timed out waiting for SSE frames")), 2_000);
      source.addEventListener(event.event, (message) => {
        values.push({ id: message.lastEventId, body: JSON.parse(message.data) });
        if (values.length === 3) {
          clearTimeout(timer);
          resolve(values);
        }
      });
      source.addEventListener("error", (error) => {
        clearTimeout(timer);
        reject(error);
      }, { once: true });
    });
    assert.deepEqual(received, [
      { id: event.eventId, body: event.body },
      { id: "late", body: event.body },
      { id: "multiline", body: event.body },
    ]);
  } finally {
    source?.close();
    await new Promise((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
  }
});

test("request targets stay closed while response targets remain additive", () => {
  const request = example("createProbe:request:dns_udp");
  request.body.target.display_name = "future response metadata";
  assertInvalid(validateExample(contract, request));

  const response = example("getOperation:200:probe_complete");
  response.body.result.target.display_name = "adapter-provided label";
  assertValid(validateExample(contract, response));

  const tcp = example("createProbe:request:dns_udp");
  Object.assign(tcp.body, { kind: "tcp_connect", purpose: "data", transport: ["tcp"] });
  assertValid(validateExample(contract, tcp));

  const wrongPurpose = structuredClone(tcp);
  wrongPurpose.body.purpose = "dns";
  assertInvalid(validateExample(contract, wrongPurpose));

  const wrongTransport = structuredClone(tcp);
  wrongTransport.body.transport = ["udp"];
  assertInvalid(validateExample(contract, wrongTransport));
});

test("runtime counters preserve nullable and numeric connection semantics", () => {
  const nullable = example("getRuntime:200:snapshot");
  for (const name of ["tcp", "udp", "total"]) nullable.body.traffic.connections[name] = null;
  nullable.body.traffic.bytes.upload = null;
  nullable.body.traffic.bytes.download = null;
  nullable.body.traffic.rates.upload_bytes_per_second = null;
  nullable.body.traffic.rates.download_bytes_per_second = null;
  assertValid(validateExample(contract, nullable));

  const zero = example("getRuntime:200:snapshot");
  for (const name of ["tcp", "udp", "total"]) zero.body.traffic.connections[name] = 0;
  assertValid(validateExample(contract, zero));

  const wrongType = example("getRuntime:200:snapshot");
  wrongType.body.traffic.connections.tcp = "0";
  assertInvalid(validateExample(contract, wrongType));
});

test("runtime memory may omit unadvertised metrics", () => {
  const memory = example("getRuntimeMemory:200:snapshot");
  delete memory.body.process.rss_bytes;
  delete memory.body.cgroup.current_bytes;
  delete memory.body.cgroup.limit_bytes;
  delete memory.body.cgroup.events;
  delete memory.body.kernel.ebpf_bytes;
  assertValid(validateExample(contract, memory));
});

test("flow snapshots advertise a schema-valid 503 response", () => {
  assertValid(validateExample(contract, example("listFlows:503:snapshot_full")));
});

test("uint64 decimal strings preserve exact limits at every current consumer", () => {
  const uint64 = { $ref: "#/components/schemas/UInt64" };
  const nullable = { $ref: "#/components/schemas/NullableUInt64" };
  for (const value of ["0", "9007199254740992", "18446744073709551615"]) {
    assertValid(contract.validate(uint64, value));
  }
  assertValid(contract.validate(nullable, null));
  for (const value of [
    0,
    9007199254740992,
    "-1",
    "+1",
    "01",
    "1e3",
    "1 ",
    "1\t",
    "1\n",
    "18446744073709551616",
  ]) {
    assertInvalid(contract.validate(uint64, value), `${JSON.stringify(value)} passed as uint64`);
  }

  const max = "18446744073709551615";
  const consumers = [
    ["getRuntime:200:snapshot", [
      "lifecycle.uptime_seconds",
      "traffic.bytes.upload",
      "traffic.bytes.download",
      "traffic.rates.upload_bytes_per_second",
      "traffic.rates.download_bytes_per_second",
    ]],
    ["getRuntimeMemory:200:snapshot", [
      "process.rss_bytes",
      "cgroup.current_bytes",
      "cgroup.limit_bytes",
      "cgroup.events.high",
      "cgroup.events.oom",
      "cgroup.events.oom_kill",
      "kernel.ebpf_bytes",
    ]],
    ["listConnections:200:visible", [
      "tcp.0.upload_bytes",
      "tcp.0.download_bytes",
      "tcp.0.upload_bytes_per_second",
      "tcp.0.download_bytes_per_second",
    ]],
    ["listFlows:200:visible", ["dropped_records"]],
  ];
  for (const [key, fields] of consumers) {
    const response = example(key);
    for (const field of fields) setPath(response.body, field, max);
    assertValid(validateExample(contract, response), key);
  }

  assertValid(contract.validate(
    { $ref: "#/components/schemas/FlowGapEvent" },
    {
      instance_id: "instance-7",
      observed_at: "2026-09-14T10:00:00Z",
      resource_id: null,
      reason: "buffer_overflow",
      dropped_records: max,
    },
  ));
});

test("the interleaved DNS flow preserves chain-specific input and port zero", () => {
  const response = example("getFlow:200:interleaved_dns");
  assertValid(validateExample(contract, response));
  assertValid(validateFlowTrace(response.body));
  const upstream = step(response.body, "route", (data) => data.chain === "dns_upstream");
  assert.equal(upstream.data.input.src_port, 0);

  const missingNetwork = example("getFlow:200:interleaved_dns");
  delete step(missingNetwork.body, "route", (data) => data.chain === "dns_upstream").data.input.network;
  assertInvalid(validateExample(contract, missingNetwork));

  const nonPort = example("getFlow:200:interleaved_dns");
  step(nonPort.body, "route", (data) => data.chain === "dns_upstream").data.input.src_port = 65_536;
  assertInvalid(validateExample(contract, nonPort));

  const swapped = example("getFlow:200:interleaved_dns");
  const request = step(swapped.body, "route", (data) => data.chain === "dns_request");
  const responseRoute = step(swapped.body, "route", (data) => data.chain === "dns_response");
  [request.data.input, responseRoute.data.input] = [responseRoute.data.input, request.data.input];
  assertInvalid(validateExample(contract, swapped));
});

test("partial traces retain unresolved references while complete traces reject them", () => {
  const complete = example("getFlow:200:interleaved_dns");
  step(complete.body, "outbound", (data) => data.attempt_id === "attempt-app").data.evaluation_id =
    "evaluation-missing";
  assertValid(contract.validate(complete.schema, complete.body));
  assertInvalid(validateFlowTrace(complete.body));

  const partial = structuredClone(complete);
  partial.body.trace_status = "partial";
  partial.body.trace.status = "partial";
  partial.body.trace.missing = ["not_instrumented"];
  assertValid(validateExample(contract, partial));
  assertValid(validateFlowTrace(partial.body));

  const unexplainedLoss = example("getFlow:200:interleaved_dns");
  unexplainedLoss.body.trace_status = "partial";
  unexplainedLoss.body.trace.status = "partial";
  assertInvalid(validateFlowTrace(unexplainedLoss.body));
});

test("flow IDs, ownership, and parent graphs remain causal", () => {
  const duplicate = example("getFlow:200:interleaved_dns").body;
  const duplicateRoute = structuredClone(step(duplicate, "route", (data) => data.chain === "traffic"));
  duplicateRoute.seq = 8;
  duplicate.trace.steps.push(duplicateRoute);
  assertInvalid(validateFlowTrace(duplicate));

  const changedOwner = example("getFlow:200:interleaved_dns").body;
  const repeatedAttempt = structuredClone(
    step(changedOwner, "outbound", (data) => data.attempt_id === "attempt-dns"),
  );
  repeatedAttempt.seq = 8;
  repeatedAttempt.data.evaluation_id = "eval-traffic";
  changedOwner.trace.steps.push(repeatedAttempt);
  assertInvalid(validateFlowTrace(changedOwner));

  const attemptCycle = example("getFlow:200:interleaved_dns").body;
  step(attemptCycle, "outbound", (data) => data.attempt_id === "attempt-dns").data.parent_attempt_id =
    "attempt-app";
  step(attemptCycle, "outbound", (data) => data.attempt_id === "attempt-app").data.parent_attempt_id =
    "attempt-dns";
  assertInvalid(validateFlowTrace(attemptCycle));

  const lookupCycle = example("getFlow:200:interleaved_dns").body;
  const dns = step(lookupCycle, "dns");
  dns.data.parent_lookup_id = dns.data.lookup_id;
  assertInvalid(validateFlowTrace(lookupCycle));
});

test("complete traces require known routing sources and DNS actions", () => {
  const unknownSource = example("getFlow:200:interleaved_dns").body;
  step(unknownSource, "outbound", (data) => data.attempt_id === "attempt-app").data.routing_source =
    "unknown";
  assertInvalid(validateFlowTrace(unknownSource));

  const missingAction = example("getFlow:200:interleaved_dns").body;
  step(missingAction, "route", (data) => data.chain === "dns_request").data.dns_action = null;
  assertInvalid(validateFlowTrace(missingAction));
});

test("partial reroutes may report an uncaptured source", () => {
  const response = example("getFlow:200:partial_handoff");
  const reroute = step(response.body, "reroute");
  Object.assign(reroute.data, {
    performed: true,
    reason: "sniffed_domain",
    from_evaluation_id: null,
    to_evaluation_id: "eval-1",
  });
  step(response.body, "route").data.plane = "userspace";
  const mode = step(response.body, "dial_mode");
  mode.data.configured = "domain++";
  mode.data.reason = "sniffed_domain";
  assertValid(validateExample(contract, response));
  assertValid(validateFlowTrace(response.body));
});

test("observability resources expose discovery, permissions and examples for every response", () => {
  const links = example("getDiscovery:200:draft").body.links;
  for (const resource of ["logs", "providers", "rules", "geodata"]) {
    assert.equal(links[resource], `/api/v1/${resource}`);
  }
  const methods = {
    "/api/v1/logs": ["get"],
    "/api/v1/providers": ["get", "post"],
    "/api/v1/providers/{id}": ["get", "delete"],
    "/api/v1/providers/{id}/refresh": ["post"],
    "/api/v1/nodes": ["get", "post"],
    "/api/v1/nodes/{id}": ["get", "delete"],
    "/api/v1/rules": ["get"],
    "/api/v1/geodata": ["get"],
    "/api/v1/geodata/update": ["post"],
  };
  for (const [path, method, permission] of [
    ["/api/v1/logs", "get", "observe"],
    ["/api/v1/providers", "get", "observe"],
    ["/api/v1/providers", "post", "control"],
    ["/api/v1/providers/{id}", "get", "observe"],
    ["/api/v1/providers/{id}", "delete", "control"],
    ["/api/v1/providers/{id}/refresh", "post", "control"],
    ["/api/v1/nodes", "post", "control"],
    ["/api/v1/nodes/{id}", "get", "observe"],
    ["/api/v1/nodes/{id}", "delete", "control"],
    ["/api/v1/rules", "get", "observe"],
    ["/api/v1/geodata", "get", "observe"],
    ["/api/v1/geodata/update", "post", "control"],
  ]) {
    const item = spec.paths[path];
    const operation = item[method];
    assert.equal(operation["x-permission"], permission);
    assert.deepEqual(Object.keys(item).filter((key) => key !== "parameters"), methods[path]);
    for (const status of Object.keys(operation.responses)) {
      const responses = [...contract.examples.values()].filter((value) =>
        value.operationId === operation.operationId && String(value.status) === status);
      assert.ok(responses.length > 0, `${path}:${status} has no response example`);
      for (const response of responses) {
        assertValid(validateExample(contract, response));
        assert.equal(response.headers["Cache-Control"], "no-store");
        assert.equal(response.headers["X-Content-Type-Options"], "nosniff");
      }
    }
  }
  assert.equal(spec.paths["/api/v1/rules"].get.responses["410"], undefined);
});

test("observability capabilities require usable bounds only when available", () => {
  for (const [resource, fields] of [
    ["logs", ["levels", "retention_seconds", "max_buffered_records"]],
    ["providers", ["can_refresh", "can_manage", "max_page_size"]],
    ["rules", ["max_rules"]],
    ["geodata", ["can_update", "assets"]],
  ]) {
    const response = example("getCapabilities:200:available");
    const advertised = response.body.resources[resource];
    for (const field of fields) {
      const saved = advertised[field];
      delete advertised[field];
      assertInvalid(validateExample(contract, response), `${resource}.${field} was optional`);
      advertised[field] = saved;
    }
    const bound = fields.at(-1);
    for (const invalid of [0, 1.5, 9007199254740992]) {
      advertised[bound] = invalid;
      assertInvalid(validateExample(contract, response));
    }
    response.body.resources[resource] = { available: false };
    assertValid(validateExample(contract, response));
    delete response.body.resources[resource];
    assertInvalid(validateExample(contract, response), `${resource} declaration was optional`);
  }
  const response = example("getCapabilities:200:available");
  for (const levels of [[], ["info", "info"], ["fatal"]]) {
    response.body.resources.logs.levels = levels;
    assertInvalid(validateExample(contract, response));
  }
  response.body.resources.logs.levels = ["info"];
  for (const retention of [0, 1.5]) {
    response.body.resources.logs.retention_seconds = retention;
    assertInvalid(validateExample(contract, response), `logs.retention_seconds accepted ${retention}`);
  }
});

test("log payloads and filters preserve typed records and the shared cursor error", () => {
  const stream = example("streamLogs:200:records");
  const bindings = spec.paths["/api/v1/logs"].get.responses["200"].content[
    "text/event-stream"
  ]["x-event-data-schemas"];
  const frames = stream.body.trim().split(/\n\n+/u).filter((frame) => !frame.startsWith(":"));
  const records = frames.map((frame) => {
    const lines = Object.fromEntries(frame.split("\n").map((line) => {
      const colon = line.indexOf(":");
      return [line.slice(0, colon), line.slice(colon + 1).trimStart()];
    }));
    assert.ok(lines.id);
    const body = JSON.parse(lines.data);
    assertValid(contract.validate({ $ref: bindings[lines.event] }, body));
    return { ...lines, body };
  });
  assert.deepEqual(records.map((record) => record.event), ["stream.ready", "log"]);
  assert.equal(new Set(records.map((record) => record.id)).size, records.length);
  const record = records[1].body;
  const schema = { $ref: bindings.log };
  record.fields = null;
  assertValid(contract.validate(schema, record));
  for (const [field, invalid] of [["ts", "yesterday"], ["level", "fatal"], ["fields", []]]) {
    const changed = { ...record, [field]: invalid };
    assertInvalid(contract.validate(schema, changed));
  }
  const request = example("streamLogs:request");
  request.parameters.find((item) => item.definition.name === "level").value = "fatal";
  assertInvalid(validateExample(contract, request));
  const target = example("streamLogs:request");
  target.parameters.find((item) => item.definition.name === "target").value = "";
  assertInvalid(validateExample(contract, target));
  const expired = example("streamLogs:409:event_cursor_expired");
  assert.deepEqual(expired.body, example("streamEvents:409:event_cursor_expired").body);
  assert.equal(expired.mediaType, "application/json");
});

test("native EventSource receives log readiness, record IDs and heartbeat framing", { timeout: 3_000 }, async () => {
  const response = example("streamLogs:200:records");
  const server = createServer((_request, outgoing) => {
    outgoing.writeHead(response.status, response.headers);
    outgoing.end(response.body);
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  let source;
  try {
    source = new EventSource(`http://127.0.0.1:${server.address().port}/api/v1/logs`);
    const received = await new Promise((resolve, reject) => {
      const values = [];
      const timer = setTimeout(() => reject(new Error("timed out waiting for log frames")), 2_000);
      for (const event of ["stream.ready", "log"]) {
        source.addEventListener(event, (message) => {
          values.push({ event, id: message.lastEventId, body: JSON.parse(message.data) });
          if (values.length === 2) {
            clearTimeout(timer);
            source.close();
            resolve(values);
          }
        });
      }
      source.addEventListener("error", (error) => {
        clearTimeout(timer);
        reject(error);
      }, { once: true });
    });
    assert.deepEqual(received.map(({ event }) => event), ["stream.ready", "log"]);
    assert.deepEqual(received.map(({ id }) => id), ["instance-7:logs:123", "instance-7:logs:124"]);
    assert.equal(received[1].body.level, "info");
    assert.equal(received[1].body.fields.generation_id, "generation-42");
  } finally {
    source?.close();
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});

test("provider create options are advertised with their defaults and bounded", () => {
  const capabilities = example("getCapabilities:200:available");
  assert.deepEqual(capabilities.body.resources.providers.create_options, {
    update_interval: 86400,
    user_agent: "honk/0.0.1-alpha",
    cache: true,
  });
  capabilities.body.resources.providers.create_options.headers = [];
  assertInvalid(validateExample(contract, capabilities), "create_options accepted an unknown option");
  delete capabilities.body.resources.providers.create_options;
  assertValid(validateExample(contract, capabilities));

  const request = example("createProvider:request:options");
  assert.deepEqual(
    Object.keys(request.body).filter((key) => !["name", "kind", "url"].includes(key)),
    ["update_interval", "user_agent", "cache"],
  );
  for (const [field, invalid] of [
    ["update_interval", -1],
    ["update_interval", 31536001],
    ["user_agent", ""],
    ["user_agent", "agent\r\nX-Injected: 1"],
    ["user_agent", "a".repeat(257)],
    ["cache", "no"],
  ]) {
    const saved = request.body[field];
    request.body[field] = invalid;
    assertInvalid(validateExample(contract, request), `${field} accepted ${JSON.stringify(invalid)}`);
    request.body[field] = saved;
  }
  request.body.update_interval = 0;
  assertValid(validateExample(contract, request));
});

test("provider examples join nodes by identity and preserve nullable exact usage", () => {
  const page = example("listProviders:200:providers");
  const provider = example("getProvider:200:subscription");
  assert.deepEqual(page.body.providers, [provider.body]);
  const nodes = example("listNodes:200:nodes");
  for (const node of nodes.body.nodes) {
    assert.equal(node.provider_id, provider.body.id);
    node.provider_id = null;
    assertValid(validateExample(contract, nodes));
    delete node.provider_id;
    assertValid(validateExample(contract, nodes));
    node.provider_id = 1;
    assertInvalid(validateExample(contract, nodes));
    delete node.provider_id;
  }
  for (const field of ["upload_bytes", "download_bytes", "total_bytes"]) {
    provider.body.traffic[field] = "18446744073709551615";
    assertValid(validateExample(contract, provider));
    for (const invalid of [9007199254740992, "18446744073709551616", "01"]) {
      provider.body.traffic[field] = invalid;
      assertInvalid(validateExample(contract, provider), `${field} lost its uint64 contract`);
    }
    provider.body.traffic[field] = null;
    assertValid(validateExample(contract, provider));
  }
  for (const download of [{route: "direct", group_id: null}, {route: "group", group_id: "group-proxy"}, {route: "group", group_id: null}]) {
    provider.body.download = download;
    assertValid(validateExample(contract, provider));
  }
  provider.body.download = {route: "proxy", group_id: null};
  assertInvalid(validateExample(contract, provider), "the route is routing, group or direct");
  provider.body.download = {route: "routing"};
  assertInvalid(validateExample(contract, provider), "group_id is always reported");
  delete provider.body.download;
  assertValid(validateExample(contract, provider), "backends that only fetch directly omit download");
  provider.body.last_error = {code: "route_unavailable", message: "The download route has no usable node yet."};
  provider.body.status = "stale";
  assertValid(validateExample(contract, provider));
  Object.assign(provider.body, {
    download: null,
    kind: "file", url_redacted: null, updated_at: null, expires_at: null, traffic: null,
    status: "error", last_error: { code: "source_unreadable", message: "Provider source is unavailable." },
  });
  assertValid(validateExample(contract, provider));
  provider.body.kind = "inline";
  assertValid(validateExample(contract, provider));
  provider.body.kind = "remote";
  assertInvalid(validateExample(contract, provider));
  const request = example("listProviders:request");
  const limit = request.parameters.find((item) => item.definition.name === "limit");
  for (const invalid of [0, 1001]) {
    limit.value = invalid;
    assertInvalid(validateExample(contract, request));
  }
});

test("provider refresh preserves acceptance, polling and terminal operation contracts", () => {
  const accepted = example("refreshProvider:202:queued");
  assert.equal(accepted.body.kind, "provider_refresh");
  const wrongKind = structuredClone(accepted);
  wrongKind.body.kind = "reload";
  assertInvalid(validateExample(contract, wrongKind));
  assert.equal(example("refreshProvider:409:in_flight").body.error.code, "state_conflict");
  const full = example("refreshProvider:503:queue_full");
  assert.equal(full.body.error.code, "temporarily_unavailable");
  for (const response of [accepted, full]) {
    delete response.headers["Retry-After"];
    assertInvalid(validateExample(contract, response));
    response.headers["Retry-After"] = 0;
    assertInvalid(validateExample(contract, response));
  }
  const operation = example("getOperation:200:reload_running");
  Object.assign(operation.body, {
    operation_id: accepted.body.operation_id,
    kind: "provider_refresh", status: "queued", started_at: null, finished_at: null,
    result: null, error: null,
  });
  assertValid(validateExample(contract, operation));
  operation.body.status = "running";
  operation.body.started_at = "2026-08-15T10:00:00Z";
  assertValid(validateExample(contract, operation));
  operation.body.status = "succeeded";
  operation.body.finished_at = "2026-08-15T10:00:01Z";
  assertInvalid(validateExample(contract, operation), "successful refresh accepted a null result");
  operation.body.result = example("getProvider:200:subscription").body;
  assertValid(validateExample(contract, operation));
  operation.body.status = "failed";
  assertInvalid(validateExample(contract, operation), "failed refresh retained a success result");
  operation.body.result = null;
  operation.body.error = { code: "fetch_failed", message: "The provider could not be refreshed." };
  assertValid(validateExample(contract, operation));
});

test("rule examples share routing-trace identities, order and fallback within one generation", () => {
  const listed = example("listRules:200:running").body;
  const trace = example("traceRouting:200:indeterminate").body;
  assert.equal(listed.generation_id, trace.generation_id);
  assert.equal(new Set(listed.rules.map((rule) => rule.rule_id)).size, listed.rules.length);
  assert.deepEqual(listed.rules.map((rule) => rule.index), listed.rules.map((_, index) => index));
  for (const rule of listed.rules) {
    const evaluated = trace.evaluations[0].rules.find((item) => item.rule_id === rule.rule_id);
    assert.ok(evaluated, `${rule.rule_id} has no matching trace example`);
    assert.equal(rule.expression, evaluated.expression);
  }
  const fallback = listed.rules.at(-1);
  assert.equal(fallback.kind, "fallback");
  assert.deepEqual(listed.fallback, { outbound: fallback.outbound, source: fallback.source });
  assert.ok(listed.rules.length <= example("getCapabilities:200:available").body.resources.rules.max_rules);
});

test("rule schemas require generation, typed source locations and one fallback", () => {
  const response = example("listRules:200:running");
  for (const [field, invalid] of [["index", -1], ["must", "false"], ["kind", "policy"]]) {
    const changed = structuredClone(response);
    changed.body.rules[0][field] = invalid;
    assertInvalid(validateExample(contract, changed));
  }
  response.body.rules[0].source.line = 0;
  assertInvalid(validateExample(contract, response));
  response.body.rules[0].source = null;
  assertValid(validateExample(contract, response));
  delete response.body.generation_id;
  assertInvalid(validateExample(contract, response));
  response.body.generation_id = "generation-42";
  response.body.rules[0].kind = "fallback";
  assertInvalid(validateExample(contract, response), "multiple fallback entries passed");
  response.body.rules = response.body.rules.filter((rule) => rule.kind !== "fallback");
  assertInvalid(validateExample(contract, response), "missing fallback passed");
});

test("DNS cache entries can name the root zone", () => {
  const page = example("listDnsCache:200:entries");
  page.body.entries[0].domain = ".";
  assertValid(validateExample(contract, page));
  page.body.entries[0].domain = "example.com";
  assertInvalid(validateExample(contract, page), "domain without a trailing dot passed");
});

test("setup lists the 401 a request with Authorization gets", () => {
  assert.equal(example("setupAdministrator:401:authentication_required").body.error.code, "authentication_required");
});

test("public discovery carries only what sign-in needs", () => {
  const view = example("getDiscovery:200:public");
  assertValid(validateExample(contract, view));
  assert.deepEqual(Object.keys(view.body).sort(), ["api_major", "auth", "links", "name"]);
  assert.deepEqual(Object.keys(view.body.links).sort(), ["auth_login", "auth_setup"]);
  assert.deepEqual(Object.keys(view.body.auth).sort(), ["mode", "setup_required"]);
  view.body.auth.anonymous_loopback = false;
  assert.notDeepEqual(validateExample(contract, view), []);
});

test("validation source IDs use the characters the server accepts", () => {
  const request = example("validateConfig:request:full");
  for (const id of ["main.dae_1-a", "a".repeat(128)]) {
    request.body.sources[0].id = id;
    assertValid(validateExample(contract, request), id);
  }
  for (const id of ["main config", "主設定", "a".repeat(129)]) {
    request.body.sources[0].id = id;
    assertInvalid(validateExample(contract, request), `${id} passed`);
  }
});

test("runtime settings patches list the body size and media type errors", () => {
  const { responses } = spec.paths["/api/v1/runtime/settings"].patch;
  assert.equal(responses["413"]?.$ref, "#/components/responses/TooLarge");
  assert.equal(responses["415"]?.$ref, "#/components/responses/UnsupportedMediaType");
});

test("group tolerance is whole milliseconds", () => {
  const group = example("getGroup:200:current");
  group.body.config.tolerance = 0.5;
  assertInvalid(validateExample(contract, group), "fractional tolerance passed");
  const patch = example("patchGroup:request:tolerance");
  const operation = patch.body.find((candidate) => candidate.path === "/config/tolerance");
  operation.value = 0.5;
  assertInvalid(validateExample(contract, patch), "fractional tolerance patch passed");
});

test("config source creation takes a relative include path and needs writable", () => {
  const capabilities = example("getCapabilities:200:available");
  assert.equal(capabilities.body.resources.config.create, true);
  capabilities.body.resources.config.writable = false;
  assertInvalid(validateExample(contract, capabilities), "create passed without writable");
  capabilities.body.resources.config.create = false;
  assertValid(validateExample(contract, capabilities));

  const request = example("createConfigSource:request:include");
  for (const path of ["proxies.dae", "config.d/proxies.dae", "a b/c.d.dae", `${"a".repeat(1020)}.dae`]) {
    request.body.path = path;
    assertValid(validateExample(contract, request), path);
  }
  for (const path of [
    "/etc/dae/proxies.dae",
    "../proxies.dae",
    "config.d/../proxies.dae",
    "./proxies.dae",
    "config.d//proxies.dae",
    "config.d/proxies.txt",
    "config.d/",
    "config.d/pro\nxies.dae",
    `${"a".repeat(1021)}.dae`,
  ]) {
    request.body.path = path;
    assertInvalid(validateExample(contract, request), `${JSON.stringify(path)} passed`);
  }
  delete request.body.path;
  assertInvalid(validateExample(contract, request), "missing path passed");
});
