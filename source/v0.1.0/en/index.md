---
title: dae API Documentation
---

# dae API Documentation

Welcome to the dae API documentation. This provides a RESTful HTTP JSON API for monitoring and controlling the dae transparent proxy.

## Overview

dae is a high-performance transparent proxy based on Linux eBPF. The API allows you to:

- Monitor real-time traffic statistics
- Report runtime status including memory usage and connection totals
- Query node latency and health status
- View active connections with per-connection network speeds
- Trace routing decisions for a hypothetical flow
- Debug DNS resolution
- Reload configuration
- Suspend/resume the proxy

All requests and responses use **JSON** (`Content-Type: application/json`). No other formats are supported.

## Quick Start

### Configuration

The API is an independent module. Add the `api { }` block to your dae configuration file:

```
api {
    port: 9527
    token: 'q/RWNF0nPm2v3eD5LxD5VA=='  # Generate with `openssl rand -base64 16` or `openssl rand -base64 32`
}
```

By default the API listens on the loopback interface only. To listen on other interfaces, configure `interfaces` and a valid token. See [API Configuration](docs/api-config.md) for the full `api { }` reference, token rules and security notes.

### Base URL

```
http://localhost:9527
```

### Authentication

If a `token` is configured in the `api` module, include it in requests:

```
Authorization: Bearer <your-token>
```

> **Note for frontend developers:** If you store the token in a cookie, make sure the token is not leaked. Serve the API over HTTPS and set the cookie with `Secure`, `HttpOnly` and `SameSite=Strict`, and never expose the token in URLs, logs, or client-side scripts.

## API Version

Current version: **v0.1.0**

## Endpoints

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/version` | Version information |
| GET | `/api/runtime/status` | Runtime status: memory, connection totals, network speed |
| GET | `/api/dns/query` | Debug DNS domain queries |
| GET | `/api/dns/cache` | DNS cache |
| GET | `/api/connections` | Active connections with per-connection speeds |
| GET | `/api/routing/trace` | Dry-run routing decisions for a hypothetical flow |
| GET | `/api/nodes/latency` | Node latency |
| POST | `/api/nodes/check` | Trigger latency checks |
| GET | `/api/groups` | Node groups |
| GET | `/api/config` | Configuration |
| POST | `/api/reload` | Reload configuration |
| POST | `/api/suspend` | Suspend service |
