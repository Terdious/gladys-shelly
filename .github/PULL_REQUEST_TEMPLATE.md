<!--
  Pull request template for a Gladys external integration.
  Reuse it as-is in other integrations built on @gladysassistant/integration-sdk.
  Delete the checklist lines that do not apply and check the ones you verified.
-->

## Summary

<!-- One or two sentences: what this PR does and why. -->

## Details

<!-- Bullet points of the concrete changes (files, behaviour). -->

-

## Scope

- **In scope:**
- **Out of scope:**

## Validation

**Quality gates** (run locally, enforced by CI):

- [ ] `npm run format:check` (Prettier)
- [ ] `npm run lint` (ESLint)
- [ ] `npm test` (unit + e2e)

**Manifest** — only when `gladys-assistant-integration.json` changed; checked against the core rules:

- [ ] `description.en` / `description.fr` are 10–100 characters
- [ ] every `config_schema[].key` is snake_case (`[a-z0-9_]+`)
- [ ] every field `type` is one of `string` / `number` / `boolean` / `select` / `secret` / `oauth2`
- [ ] `docker_image` carries an explicit tag (no implicit `latest`)
- [ ] N/A — the manifest is unchanged

**Real-world test** — only for behavioural changes; run the `:dev` image against a live Gladys core:

- [ ] the container starts and connects to Gladys over WebSocket (`docker logs`)
- [ ] the configuration screen renders and `secret` fields are masked
- [ ] discovery lists the devices, and each one is created **without a selector conflict**
- [ ] telemetry flows: polling and/or real-time push update the feature states
- [ ] control works (if the integration exposes writable features)
- [ ] N/A — no runtime behaviour changed

## Related

<!-- Upstream PRs, issues, follow-up work, dependencies. -->

-
