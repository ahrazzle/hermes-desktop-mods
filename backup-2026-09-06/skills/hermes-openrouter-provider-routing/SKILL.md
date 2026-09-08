---
name: hermes-openrouter-provider-routing
description: "Configure OpenRouter routing with Baidu preference."
---

Use `extra_body.provider`: `order: [baidu, ...]` + `sort: throughput`. Propagate to profiles by adding `openrouter:` section without changing current `model.default`. Validate YAML; insertion points vary by profile (`database:` vs `fallback_providers:`).
