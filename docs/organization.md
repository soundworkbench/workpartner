# Organization configuration

`WORKPARTNER_ORG_DIR` selects the organization directory. The neutral configuration is in `org/default/organization.json`; its schema and the resolver in `gateway/organization/resolve.mjs` define the accepted fields. Copy the directory before customizing it. Store organization-specific values outside the source tree.

| Configuration group | Purpose |
| --- | --- |
| `displayName`, `productName` | Organization name and localized product names |
| `publicHost` | Your public HTTPS hostname and login callback host |
| `identity` | Provider, application identity, secret file reference and admission policy |
| `model` | Your model endpoint, key policy and agent defaults |
| `runtime` | Image, network, container names, limits and host data paths |
| `appearance` | Neutral or custom assets and interface copy |
| `image` | Optional skills and instruction templates |
| `bridge` | Reserved messaging bridge input; unsupported in this preview |

Set the public hostname and model endpoint explicitly. Give the login application its own credentials and reference secret files instead of placing secrets in JSON. The default configuration contains no organization accounts, admission group, private model endpoint, preinstalled organization skills or enabled messaging bridge. Branding assets and instructions belong to the selected organization directory.

The optional bridge binary is the upstream cc-connect 1.5.0 release. Its configuration differs from customized distributions: `stream_preview.typing_marker`, `keep_preview_on_finish`, and `p2p_thread_isolation` are unsupported and must not be generated. Do not substitute `thread_isolation` for the last option without testing its behavior. The default organization leaves `bridge.template` disabled and supplies no bot configuration or credentials.

This preview does not package a bridge onboarding page or personal platform authorization. Leave `bridge.template` empty; administrators may configure the upstream binary separately after checking its supported options.
