# Managed MCP hub

An organization can connect a personal workspace to a Streamable HTTP MCP hub. Set these non-secret fields in `organization.json`:

```json
{
  "mcpHub": {
    "url": "https://tools.example.com/mcp",
    "name": "workpartner-hub",
    "keyEnvironment": "MODEL_API_KEY",
    "displayNames": "mcp-display.json",
    "hidden": ["search__web_search", "search__web_fetch"]
  }
}
```

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

The authenticated, read-only `GET /_wp/market/tools` route discovers tools using the caller's key. It returns only names, localized titles, and one-line descriptions. Missing translations use the hub's title/name and description. Responses are never cached across people. No key, schema, connection URL, or authentication header is returned to the page. A denied key or a disabled hub produces an empty list; temporary discovery failures produce a retry state.

`hidden` is an optional list of exact `server__tool` names omitted from this market response. Omit it or use `[]` to show every discovered tool. Use names from your own hub's current `tools/list` response; the example prefixes above are illustrative. Names are case-sensitive, without wildcard matching; unknown names have no effect. This is display configuration only: both engines still discover and can call hidden tools through the same hub, and startup still enables the hub when all its tools are hidden. It does not revoke access or change native search behavior.

Acceptance: configure one discovered tool as hidden and check that it is absent from `/_wp/market/tools` and the Tools tab while another tool remains visible. In new Claude Code and Codex sessions, list and call that same hidden tool. With all tools hidden the market has its empty state but both engines remain connected. Remove the list and confirm the tools appear again. A string, null, wildcard, or unqualified tool name must fail organization validation.

## Startup and personal configuration

Startup performs one discovery with a **three-second total deadline**, including initialization and reading the response. Paginated hubs require additional `tools/list` requests within the same deadline. JSON and streaming SSE responses are supported. Missing keys make no request. Empty or failed discovery removes previously managed entries; failure only emits a generic warning and startup continues.

Codex receives a `[mcp_servers.<name>]` table between `BEGIN/END WORKPARTNER MCP` comment lines in `~/.codex/config.toml`, with `url` and `bearer_token_env_var`. Claude Code receives an HTTP entry in `~/.claude.json`. JSON cannot contain comment marker lines, so a root `_workpartnerMcp` ownership record identifies the managed server. The updater splices JSON properties instead of reformatting the entire file: personal property text and all unrelated values remain unchanged. It handles hub renames and refuses to overwrite a colliding personal server name. Both files are validated before either is updated and are written atomically with private permissions. Repeated starts produce identical files.

Claude Code supports `${ENV_VAR}` in headers, but [excludes credential names such as `ANTHROPIC_API_KEY`](https://code.claude.com/docs/en/mcp#credential-variables-that-read-as-empty). The entry therefore uses a `headersHelper` that reads the configured variable and sends its Authorization header directly to Claude Code. It stores no credential. `alwaysLoad: true` keeps this hub's individual tools visible rather than deferring them behind tool search. Existing personal servers retain their own settings.

## Tools page integration

The Tools tab has one scrolling category row and uses the Skills card style. MCP contributes a read-only `MCP` category when tools exist. A zero-tool page shows “Tools are not enabled”; failure shows a retry action. There are no switches or execution buttons on MCP cards.

`wp-tools.js` owns the Tools renderer. Other tools modules (including the data catalog in #31) contribute to the same host with `window.wpMarketTools.registerSource(load)` rather than replacing `wpMarket.register('tools', ...)`. `load({locale, signal})` returns a promise of:

```js
{
  categories: [{ id: 'unique-category', label: 'Category', render(panel) { /* return optional cleanup */ } }],
  renderHeader(header) { /* optional quota header; return optional cleanup */ }
}
```

A data source should return one category per configured data category, with its platform filter and cards inside `render`, and place quota blocks in `renderHeader`. Headers remain above the shared category row. The host handles category navigation, locale changes, async results, cancellation, and disposal. Data catalog integration is a prerequisite before merging both features together; #31 is not included in this PR.

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

Run `python3 -I image/tests/mcp-preview.py`, then open `http://127.0.0.1:18333/#/market` and select Tools to reproduce the visual fixture. Add `?dark=1`, `?lang=en`, or `?empty=1` before the hash to check those states.

The preview screenshots use the actual market host, Tools renderer, and stylesheet with neutral fixture metadata: [desktop light](images/mcp-tools-light.png), [desktop dark](images/mcp-tools-dark.png), [390px phone](images/mcp-tools-phone.png). Deployment still needs an organization-owned hub configuration and display table, a new image, and gateway restart. After deployment, start a fresh session in each engine and call one authorized hub tool; then verify denied/zero-tool behavior, personal configuration preservation, and zh/en page metadata using real accounts.
