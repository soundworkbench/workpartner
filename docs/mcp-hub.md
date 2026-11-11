# Managed MCP hub

An organization can connect a personal workspace to a Streamable HTTP MCP hub. Set these non-secret fields in `organization.json`:

```json
{
  "mcpHub": {
    "url": "https://tools.example.com/mcp",
    "name": "workpartner-hub",
    "keyEnvironment": "MODEL_API_KEY",
    "displayNames": "mcp-display.json",
    "hidden": ["search__web_search", "search__web_fetch"],
    "defaultCategory": "Creation",
    "categories": [{ "en": "Creation", "zh": "内容生成" }],
    "platform": { "id": "media", "name": { "en": "Media service", "zh": "创作服务" } },
    "tools": {
      "documents__read": {
        "category": "Research",
        "platform": { "id": "library", "name": { "en": "Library", "zh": "资料库" } }
      },
      "media__render": {
        "example": { "en": "Create a short video", "zh": "制作一段短视频" }
      }
    }
  }
}
```

In this example, `Research` is a category already defined in the selected data catalog. Category keys use the English `en` value from `dataTools` categories or `mcpHub.categories`. `defaultCategory` selects the fallback for tools without an explicit `category`; it must exist in one of those lists. Unconfigured presentation defaults to the neutral Tools category and Tool service platform. Each tool can override the hub-level platform and optionally supply a localized example. These fields affect presentation only and never grant tool access.

Use the hub's complete root MCP endpoint, without an agent-specific suffix. The configured environment variable must already hold the person's key in the workspace. The gateway uses that person's existing model key file, so this key must authorize both model access and hub access. No new key is provisioned by this feature. `mcpHub: null` (the default) disables discovery without making a network request.

`displayNames` is an optional organization-owned JSON file. It is read by the gateway only and does not need to be baked into the personal image:

```json
{
  "documents__read": {
    "zh": { "name": "读取文档", "description": "读取指定文档。" },
    "en": { "name": "Read document", "description": "Read a document." }
  }
}
```

The authenticated, read-only `GET /_wp/market/tools` route discovers tools using the caller's key. It returns names, localized titles and one-line descriptions, category/platform metadata, the included-price flag, and optional organization-owned examples. Missing translations use the hub's title/name and description. Responses are never cached across people. No key, schema, connection URL, or authentication header is returned to the page. A denied key or a disabled hub produces an empty list; temporary discovery failures produce a retry state.

`hidden` is an optional list of exact `server__tool` names omitted from this market response. Omit it or use `[]` to show every discovered tool. Use names from your own hub's current `tools/list` response; the example prefixes above are illustrative. Names are case-sensitive, without wildcard matching; unknown names have no effect. This is display configuration only: both engines still discover and can call hidden tools through the same hub, and startup still enables the hub when all its tools are hidden. It does not revoke access or change native search behavior.

Acceptance: configure one discovered tool as hidden and check that it is absent from `/_wp/market/tools` and the Tools tab while another tool remains visible. In new Claude Code and Codex sessions, list and call that same hidden tool. With all tools hidden the market has its empty state but both engines remain connected. Remove the list and confirm the tools appear again. A string, null, wildcard, or unqualified tool name must fail organization validation.

## Startup and personal configuration

Startup performs one discovery with a **three-second total deadline**, including initialization and reading the response. Paginated hubs require additional `tools/list` requests within the same deadline. JSON and streaming SSE responses are supported. Missing keys make no request. Empty or failed discovery removes previously managed entries; failure only emits a generic warning and startup continues.

Codex receives a `[mcp_servers.<name>]` table between `BEGIN/END WORKPARTNER MCP` comment lines in `~/.codex/config.toml`, with `url` and `bearer_token_env_var`. Claude Code receives an HTTP entry in `~/.claude.json`. JSON cannot contain comment marker lines, so a root `_workpartnerMcp` ownership record identifies the managed server. The updater splices JSON properties instead of reformatting the entire file: personal property text and all unrelated values remain unchanged. It handles hub renames and refuses to overwrite a colliding personal server name. Both files are validated before either is updated and are written atomically with private permissions. Repeated starts produce identical files.

Claude Code supports `${ENV_VAR}` in headers, but [excludes credential names such as `ANTHROPIC_API_KEY`](https://code.claude.com/docs/en/mcp#credential-variables-that-read-as-empty). The entry therefore uses a `headersHelper` that reads the configured variable and sends its Authorization header directly to Claude Code. It stores no credential. `alwaysLoad: true` keeps this hub's individual tools visible rather than deferring them behind tool search. Existing personal servers retain their own settings.

## Tools page integration

The Tools tab follows the data catalog layout: filled category pills, platform filters, and two-column cards (one column on a phone). Hub tools join existing data categories by category key, or add an organization-defined category. No MCP category is created. Cards share the same title, description, top-right platform label, and footer. Hub tools show “Included” in the price position and show “Try it” only when the organization supplies an example. Data cards keep their prices and examples.

`wp-tools.js` owns the shared renderer. `wp-data-tools.js` and `wp-mcp-tools.js` contribute with `window.wpMarketTools.registerSource(load)` rather than replacing `wpMarket.register('tools', ...)`. The image loads the host first, then the data source and hub source, preserving data category order. `load({locale, signal})` returns a promise of:

```js
{
  categories: [{
    id: 'Research', name: { zh: '研究', en: 'Research' },
    platforms: [{ id: 'library', name: { zh: '资料库', en: 'Library' } }],
    async loadTools(platformId) { /* empty string selects all; return card metadata */ }
  }],
  renderHeader(header) { /* optional quota header; return optional cleanup */ }
}
```

The host merges identical category/platform IDs, renders cards once, sorts recommended data examples first, and pages results in batches of 12. Headers stay above categories. Only the data source contributes personal quota blocks, and only when it has data platforms. Empty and retry messages appear in the selected category's card area; a failed hub still returns configured categories so other data categories remain usable. Refreshing retries discovery. Category/filter changes, source registration/removal, locale changes, pending requests and disposal are handled by the shared host.

## Verification

Run the focused behavior checks with Node.js 24:

```sh
node --test tools/mcp-hub.test.mjs
```

To verify the pinned clients without a paid model call:

```sh
python3 -I image/tests/verify-mcp-engines.py --claude /path/to/claude --codex /path/to/codex
```

This creates disposable homes and a local 12-tool hub. Claude Code calls the final tool using a local model stub; Codex uses its app-server tool-call API. Both must authenticate through generated configuration, list all 12 individual tools, and call one successfully. Versions are checked against the image pins. It does not validate an organization's live hub or production sessions.

Run `python3 -I image/tests/mcp-preview.py`, then open `http://127.0.0.1:18333/#/market` and select Tools to reproduce the visual fixture. Add `?dark=1`, `?lang=en`, `?mode=empty`, `?mode=hub-only`, or `?fail=1` before the hash to check those states. The fixture loads both actual source modules; Research contains both data and hub cards and Creation contains hub cards. Remove `fail` from the URL and refresh the list to check recovery.

Keep preview screenshots in a local evidence directory, outside the repository. Capture both a data category and a hub-populated category for desktop light/dark and a 390px phone. Fixture metadata is illustrative; this proves the combined renderer, not a live provider call.

Deployment needs an organization-owned hub configuration and display table, a new personal image, and a gateway restart. After deployment, start a fresh session in each engine and call one authorized hub tool; then verify denied/zero-tool behavior, personal configuration preservation, and zh/en page metadata using real accounts.
