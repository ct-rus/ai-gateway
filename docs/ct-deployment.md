# Cointelegraph RU gateway

Use this guide to access and operate the existing CT AI gateway at
[ai.ctcrm.net](https://ai.ctcrm.net). It connects CLIProxyAPI (CPA) to the
Oh My CPA (OMC) management console on `ct-ru-1`.

## How to open the console

1. Open [ai.ctcrm.net](https://ai.ctcrm.net) and sign in through Hello Screen.
2. Confirm the account has the `ai-gateway` service grant. Sign in to OMC with
   the CPA management key as well.
3. Keep the management key, Hello credentials, provider credentials and client
   keys private. They serve different purposes; do not put them in Git or logs.

## How to maintain provider access

1. Arrange your own compatible provider access. The existing access depends on
   the previous owner's subscription, which runs until **5 December 2026**.
2. Before changing the configuration, confirm the provider's authentication
   method and model compatibility. Keep its credentials private.
3. Use the OMC console to manage the provider. Verify the affected clients and
   models after an authorized change; provider calls can incur costs.

## How to connect a client

1. Create a distinct CPA client key for the person in the OMC console.
2. Set the client's OpenAI-compatible base URL to `https://ai.ctcrm.net/v1` and
   store the client key using the client's private secret mechanism.
3. Confirm that the client and chosen model support the exposed APIs. An
   Anthropic-native `/v1/messages` client needs a compatible adapter.

CPA authenticates the public inference route with a client key, without Hello.
Existing CPA inference keys, including CRM keys, also work on this route; review
exposure, rotation, revocation and provider spend. See the
[public inference runbook](https://github.com/ct-rus/infrastructure/blob/main/ansible/docs/AI-GATEWAY-PORTAL.md#public-inference-route-update).

## How to operate or recover the deployment

1. Read the [infrastructure gateway guide](https://github.com/ct-rus/infrastructure/blob/main/ansible/docs/AI-GATEWAY.md)
   and [portal runbook](https://github.com/ct-rus/infrastructure/blob/main/ansible/docs/AI-GATEWAY-PORTAL.md).
   Check each procedure's status: historical preparation is not a new instruction.
2. Obtain separate authorization and coordinate the affected services before
   deployment, changes to the shared edge, or other server writes.
3. Follow the applicable runbook's prerequisites, checks and rollback procedure.
   Preserve private snapshots and diagnostics; do not blindly retry a failed or
   interrupted operation.

The generic [install guide](install.md) creates a separate installation; it is
not an update procedure for this gateway. The [archived cpamp repository](https://github.com/ct-rus/ai-gateway-cpamp-archive)
records an earlier panel; the generic [other panels](install.md#other-management-panels)
setup does not describe this deployment.

## Reference

| Access or route | Purpose and limit |
| --- | --- |
| Hello `ai-gateway` grant | Allows access through the portal; it is separate from OMC sign-in. |
| CPA management key | Signs in to the OMC console; do not use it as a client key. |
| Provider credentials | Let CPA use the configured upstream provider. |
| CPA client key | Authenticates inference requests; use a separate personal key. |
| Public inference | `GET /v1/models`; `POST /v1/chat/completions`, `/v1/completions`, `/v1/embeddings`, `/v1/responses`. Other `/v1` paths and `/v8/*` are blocked at the edge. |

## History

As of 19 November 2026, the deployment and provider configuration had not been
rechecked on the server for the handover documentation. Earlier operator reports
and their limitations are in the [infrastructure inventory](https://github.com/ct-rus/infrastructure/blob/main/docs/INVENTORY.md)
and the runbooks above.
