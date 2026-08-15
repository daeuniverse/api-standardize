---
title: Errors
---

# Error responses

All native API errors use one JSON envelope:

```json
{
  "error": {
    "code": "stale_revision",
    "message": "The resource changed; fetch it again before retrying.",
    "details": {
      "field": null
    }
  },
  "request_id": "request-01HZX4K8W5"
}
```

| Field | Type | Description |
|-------|------|-------------|
| error.code | string | Stable machine-readable code. |
| error.message | string | Short safe description for an operator. |
| error.details | object or null | Optional structured details; never raw engine output. |
| request_id | string or null | Identifier for correlating server-side logs. |

## Shared status semantics

| Status | Typical code | Meaning |
|--------|--------------|---------|
| 400 | `invalid_request` | Malformed parameter or request shape. |
| 401 | `authentication_required` | Credentials are missing or invalid. |
| 403 | `permission_denied` | The authenticated caller cannot perform the action. |
| 404 | `resource_not_found` | The requested resource does not exist. |
| 404 | `capability_not_supported` | The running adapter does not expose the resource or action. |
| 409 | `state_conflict` | Current runtime state prevents the requested transition. |
| 409 | `idempotency_conflict` | An idempotency key was reused with a different request body. |
| 412 | `stale_revision` | `If-Match` does not match the current resource revision. |
| 413 | `request_too_large` | Request or requested fan-out exceeds an advertised limit. |
| 415 | `unsupported_media_type` | Request `Content-Type` is unsupported. |
| 422 | `unsupported_value` | Syntax is valid but a field, value, or transition is unsupported. |
| 428 | `precondition_required` | A required `If-Match` header is missing. |
| 429 | `rate_limited` | A request or operation limit was reached. |
| 503 | `temporarily_unavailable` | A bounded queue or required runtime component is unavailable. |

Responses with `429` or retryable `503` include `Retry-After`. Errors must not
contain bearer secrets, proxy credentials, private keys, raw configuration,
stack traces, local file paths, or unredacted chained engine errors.
