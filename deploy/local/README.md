# Local gateway

This local-only installation runs CPA v8.0.62 and Oh My CPA v0.3.26, each
pinned by release tag and image digest in `compose.yml`. Docker Engine, Docker
Compose, the repository's pinned Node/pnpm toolchain and a non-root Unix user
are required. The JS scripts reuse the existing `yaml` package to validate CPA
settings. Commands below run from the repository root.

```sh
pnpm install --frozen-lockfile
node scripts/local-gateway.mjs setup --json
node scripts/local-gateway.mjs start --json
node scripts/local-gateway.mjs status --json
node scripts/local-gateway.mjs check --json
```

`start` also runs setup if needed. Repeating setup or start preserves existing
keys, CPA configuration, providers and panel data; incomplete state is refused
instead of being regenerated. Setup checks the required files and credentials
and records when a panel database exists, so losing that database later refuses
startup. A startup attempt is recorded before Compose runs, because a failed wait
may already have created data. A retry with a missing database requires operator
investigation or restoration. An older installation is adopted only with its database present.
Container ownership includes the checkout path and the exact private bind mounts;
commands from another checkout refuse to operate on the stack. Docker service
or permission failures are reported as errors rather than absent containers.
The ports must be available. The stack uses the
dedicated `10.254.83.0/28` Docker network; a conflicting route or network must
be resolved before starting it. No existing process or network is removed.

- Panel: <http://127.0.0.1:28318/>. Open `.local/management-key` in a private
  local editor and use its contents as the sign-in password.
- Gateway: <http://127.0.0.1:28317/v1>. A local client can read its bearer key
  from `.local/client-key`. The client key is separate from the management key.
- The panel collects usage; no updater or Docker socket is installed. Both
  ports bind only to loopback. This is plain HTTP on the local machine, so its
  HttpOnly session cookie does not carry the HTTPS-only `Secure` flag.

`check` verifies the running containers and their bindings, image pins and
health, the panel app, client authorization, management isolation, a real
management-key session, authenticated CPA connectivity, and usage collection. A panel healthcheck
can be green while its CPA connection is degraded; `check` requires both.
An empty `/v1/models` list is expected until a provider is configured. All
commands emit JSON; `--json` is accepted explicitly as shown above.

## Connect a Codex account

In **OAuth management**, start Codex sign-in and open the authorization link.
After approving access, the browser redirects to `localhost:1455`; the callback
page may fail to connect because this local stack does not publish that port.
Copy the complete URL from the browser address bar, including its query
parameters, into **Redirect Callback URL** in the panel and select **Submit
Callback**. Wait for the panel to report that authorization succeeded. Manual
callback paste has succeeded with this local setup; port 1455 does not need to be
exposed. Treat the callback URL as a secret and do not share or log it.

## Add an API-key provider and opt in to a model test

In the panel, open **AI Providers → Add Provider**, select **OpenAI Compatible**,
enter the provider's API key and endpoint base URL, add the intended model under
**Custom Models**, and save. OpenAI's base URL is `https://api.openai.com/v1`;
OpenRouter's is `https://openrouter.ai/api/v1`. Use a model name the selected
account can access. Provider credentials are entered into the panel by the
operator; they are not required for setup or `check`.

Only when ready to make real, potentially billable model requests:

```sh
MODEL='your-configured-model-name' node scripts/local-gateway.mjs model-check --live --json
```

This sends three chat-completion requests. It requires a single `add_numbers`
tool call with arguments `17` and `25`, calculates that fixed result locally,
then sends the tool result with the same tool definitions and `tool_choice`
set to `none`. It requires the final answer to be exactly `42`, then requests and
validates a separate JSON object using `response_format: json_object`. It does not
execute model-supplied code or display raw model output. No other command makes
a model request. The automated script tests use mock HTTP servers and are not
evidence of a real provider request:

```sh
node --test scripts/local-gateway.test.mjs
```

## Stop, restart and back up

```sh
node scripts/local-gateway.mjs stop --json
node scripts/local-gateway.mjs start --json
```

Private state is under `.local/`: `cpa/config.yaml`, CPA `auth/`, `logs/` and
`plugins/`, the panel's `omc/` database and key envelope, the management and
client key files, and the service environment files including the panel master
key. This directory is excluded from Git and the Docker build context. Keep it
private: CPA runs as root in its image and may create files requiring elevated
access for backup.

For a consistent cold backup, stop both services, then archive the entire
`.local` directory outside the repository in a private location. For example:

```sh
node scripts/local-gateway.mjs stop --json
mkdir -p -m 700 "$HOME/ai-gateway-backups"
backup_file="$HOME/ai-gateway-backups/local-gateway-$(date +%Y%m%d-%H%M%S).tar.gz"
sudo tar -czf "$backup_file" .local
sudo chmod 600 "$backup_file"
node scripts/local-gateway.mjs start --json
```

The archive contains credentials and encryption material; protect it as a
secret. `stop` checks container ownership without requiring a healthy database,
so it remains available when restoring lost panel data. To restore a cold backup,
stop the stack, preserve the current state,
restore `.local` in the repository with its original ownership and permissions,
then start and run `check`. The panel can also export an encrypted SQLite backup
from **System Information → Database → Manage backups**, but that export does
not include CPA config, auth files or deployment keys. See
[`docs/ops/sqlite-operations.md`](../../docs/ops/sqlite-operations.md) for
online backup and restore details.

## Later Dev acceptance checks

These separate checks are for the planned Dev deployment, not the local stack.
They are opt-in and make real model requests; use them only after the inference
route and CRM activation have been independently accepted and the operator has
approved paid calls. The provider command must run from the approved inference
network; its fixed origin is `http://ct-ai-inference:8317`. The CRM command is
fixed to `https://crm-dev.ctcrm.net`. Neither accepts an arbitrary CLI origin.

Place each input in an absolute, owner-only regular JSON file (mode 0600, one
link) outside the repository. The provider input has exactly `client` (inference
bearer key) and `model` (the exact selected model ID). The CRM input has exactly
`email`, `password`, `role` (the expected CRM role ID) and `route` (the expected
first route, for example `openai:gpt-6.1-sol`). Do not put credentials in command
arguments. Choose a new absolute receipt path in an owner-only directory; an
existing file is never replaced. For example, with private paths already created:

```sh
node scripts/verify-provider.mjs --live --input /private/provider.json --receipt /private/provider-receipt.json
node scripts/verify-crm.mjs --live --input /private/crm.json --receipt /private/crm-receipt.json
node --test scripts/verify-provider.test.mjs scripts/verify-crm.test.mjs
```

Receipts contain bounded metadata, not credentials, prompts, answers or cookies.
The provider checks missing and wrong inference keys and the management 404 on
that same inference boundary; public panel and direct-control boundaries, panel
sessions and the usage collector require separate checks from their appropriate
network boundaries. The provider sends three inference requests without retries.
The CRM check sends one ask and logs out even when a later check fails. If login
or logout loses its response, session state can be ambiguous and needs manual
investigation; an ask with a lost response is never replayed. The CRM command
returns a nonzero exit with `httpWorkflow: passed` and `traceNotVerified: true`
when its HTTP checks pass: HTTP history does not prove a model/tool cycle. An
independently reviewed CRM change must include the ask request ID in the same
`copilotAsk` trace (and validate read/completion evidence) before exact per-ask
trace correlation and final tool-cycle acceptance can be claimed. The currently
available user-and-time trace is insufficient. These synthetic tests are not
live acceptance evidence.
