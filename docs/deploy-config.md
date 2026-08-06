# Deploy configuration (for #56–59)

## Azure resources (#56)

Early scope, per the cost-ladder decision in architecture.md §Deployment shape: provision the
substrate now so subscription and quota problems surface here rather than at deploy week.
App Service and the database are deliberately absent — they arrive in #57, when the pipeline
needs a target.

Method is clickops, per the PRODUCT.md non-goal on IaC. The `az` commands below are a **record
of what was created**, not a deployment mechanism: there is no state file, nothing re-runs them,
and the portal is an equally valid way to produce the same resources. They are written down
because "documented config" at one environment means someone can reproduce it by hand.

### Status

| | |
|---|---|
| Provisioned | **No.** Nothing in this section has been created yet. |
| Blocker | Azure CLI is not installed on the dev machine, and `az login` is interactive. |
| Owner | The human. Run §Preflight, then §Create, then fill in the two `<fill in>` values below. |
| CLI | `winget install Microsoft.AzureCLI`, then `az login`. Or do the whole thing in the portal — the commands below are a record, not a requirement. |

### Preflight: can this subscription provision at all?

The ticket's first item, and the reason it is first: quota and policy failures on this account
are a known risk, and the expensive version of finding out is at deploy week with a pipeline
half-written. Run all six before creating anything. Each answers a different failure mode.

```bash
# 1. Is there a usable subscription, and is it Enabled (not Warned/PastDue/Disabled)?
az account show --query "{name:name, id:id, state:state, tenant:tenantId}" -o table

# 2. Is the target region offered to THIS subscription? Sponsored and student
#    subscriptions are routinely narrower than the public region list.
az account list-locations --query "[?name=='canadacentral'].name" -o tsv

# 3. Resource-provider registration. The single most common hard stop on a restricted
#    subscription, and it fails at create time with a message that reads like a bug.
for p in Microsoft.Storage Microsoft.Insights Microsoft.OperationalInsights; do
  echo -n "$p: "; az provider show -n $p --query registrationState -o tsv
done
# Any that says NotRegistered:  az provider register -n <name>   (takes a minute or two)

# 4. Policy assignments. Sponsored subscriptions commonly carry allowed-location and
#    allowed-SKU policies that reject a create with a generic "disallowed by policy".
az policy assignment list --query "[].{name:displayName, enforcement:enforcementMode}" -o table

# 5. Is the storage account name globally available? (Global namespace, not per-subscription.)
az storage account check-name --name sttraineros --query "{available:nameAvailable, why:reason}" -o table

# 6. FORWARD CHECK FOR #57, run now on purpose. This is the whole point of the rescope:
#    if F1 is not offered here, the cost ladder's first rung does not exist and that is a
#    decision to make now, not in the middle of writing the deploy pipeline.
az appservice list-locations --sku F1 --query "[?name=='Canada Central']" -o table
```

If 6 comes back empty, do not improvise. It means the ladder starts at B1 (~$13/mo) or in a
different region, and that is a cost decision that belongs to the human, not to #57.

### Resources

| Resource | Name | Region | SKU / tier | Why |
|---|---|---|---|---|
| Resource group | `rg-traineros` | `canadacentral` | n/a | One environment (PRODUCT.md). A second group buys nothing to separate. |
| Storage account | `sttraineros` *(see note)* | `canadacentral` | Standard_LRS, StorageV2 | Queue Storage for notifications.md, and `AzureWebJobsStorage` for the Function App. |
| Queue | `reminders` | | | notifications.md §Queue. |
| Queue | `reminders-poison` | | | Name is **derived, not chosen** — see gotchas. |
| Log Analytics workspace | `log-traineros` | `canadacentral` | PerGB2018 | Mandatory dependency of App Insights, not an extra. See gotchas. |
| Application Insights | `appi-traineros` | `canadacentral` | Workspace-based | notifications.md §Observability: one alert on the poison-queue function's error logs. |

**Region: `canadacentral`.** The trainer and the clients are in the Toronto area (the seeded
timezone is `America/Toronto`), so it is both the lowest-latency choice and the one that keeps
personal training data in-country. #57's App Service must land in the same region: a split would
put every API call to Queue Storage across a region boundary for no benefit.

**Storage name.** Storage account names are globally unique, 3–24 chars, lowercase alphanumeric
only, no hyphens — which is why this one breaks the `st-` convention the other names follow.
`sttraineros` is the preferred name; if preflight 5 says it is taken, append digits and record
the result here:

- Storage account actually created: `<fill in>`

**Redundancy: LRS, deliberately.** Not a cost reflex. notifications.md is explicit that the
database is the source of truth and the queue is only a delivery mechanism: "if the queue
disappeared tomorrow, no data would be lost, only timeliness." A lost queue is recovered by the
pending-sweep. Paying for ZRS or GRS would be insuring the one component in the system that is
already designed to be disposable.

### Create

```bash
LOC=canadacentral
RG=rg-traineros
ST=sttraineros            # replace if preflight 5 said taken

az group create -n $RG -l $LOC

az storage account create -n $ST -g $RG -l $LOC \
  --sku Standard_LRS --kind StorageV2 \
  --min-tls-version TLS1_2 --https-only true --allow-blob-public-access false

# Left on the default key auth rather than --auth-mode login. Owning the subscription does not
# grant data-plane access: queues are governed by a separate RBAC role (Storage Queue Data
# Contributor), so --auth-mode login fails with AuthorizationPermissionMismatch for an Owner who
# has not also been given that role. Default auth reads the account key over the management
# plane, which an Owner does have. Nothing is pasted into the shell either way.
az storage queue create -n reminders        --account-name $ST
az storage queue create -n reminders-poison --account-name $ST

az monitor log-analytics workspace create -n log-traineros -g $RG -l $LOC

# --workspace is not optional. Without it this creates a classic App Insights resource,
# which was retired in Feb 2024. See gotchas.
# If the command is not found: az extension add --name application-insights
az monitor app-insights component create \
  -a appi-traineros -g $RG -l $LOC \
  --workspace $(az monitor log-analytics workspace show -n log-traineros -g $RG --query id -o tsv)
```

Verify the six resources landed:

```bash
az resource list -g $RG --query "[].{name:name, type:type, location:location}" -o table
az storage queue list --account-name $ST --query "[].name" -o tsv   # expect: reminders, reminders-poison
```

### Values this produces, and where they go

Both are secrets. Neither goes in this repo (architecture.md: "No secrets in repo"). Record only
that they exist and which setting consumes them.

| Value | Read it with | Consumed by |
|---|---|---|
| Storage connection string | `az storage account show-connection-string -n $ST -g $RG` | Function App setting `AzureWebJobsStorage`, and the scheduler's queue client (#57) |
| App Insights connection string | `az monitor app-insights component show -a appi-traineros -g $RG --query connectionString` | Both hosts, as `APPLICATIONINSIGHTS_CONNECTION_STRING` |

- App Insights connection string recorded in App Service / Function App config: `<fill in: date>`

Use the **connection string**, not the instrumentation key. Key-only configuration is deprecated
and the newer SDKs ignore it.

### Cost, honestly

architecture.md's honest-cost habit applies to the small numbers too. "All free tier" in the
ticket is approximately true and not literally true:

- Resource group, Log Analytics workspace, App Insights resource: **$0** to exist.
- Log Analytics / App Insights ingestion: 5 GB per month free, then ~$2.30/GB. At v1 scale
  (two functions, ~9 reminders a day) this stays inside the grant indefinitely.
- **Storage account: no free tier exists.** Standard_LRS is pay-as-you-go from the first byte.
  At this volume it is a few cents a month — under $0.05 for storage plus transactions — but it
  is not zero, and on a subscription with a hard spending cap it is the line item that keeps
  ticking when nothing else does.

Total realistic run rate for #56's resources: **well under $1/month**, and $0 of it is App
Service or Postgres, which is the entire point of deferring those to #57.

## App Service (API)
- ConnectionStrings:Postgres
- Resend:ApiKey
- Resend:From  (noreply@traineros.me)
- Notifications:PauseTokenKey  (must be IDENTICAL to the Function App's value)
- App:BaseUrl = (https://traineros.me)
- Seed__TrainerEmail / Seed__TrainerPassword  (first boot only; seeds the trainer)
- Health check path is /api/health, NOT /health
- APPLICATIONINSIGHTS_CONNECTION_STRING — fetch with:
  az monitor app-insights component show --app appi-traineros --resource-group rg-traineros --query connectionString -o tsv

## Function App
- ConnectionStrings:Postgres
- Resend:ApiKey 
- Resend:From (noreply@traineros.me)
- Notifications:PauseTokenKey  (same value as App Service)
- App: BaseUrl = https://traineros.me
- Queue Storage connection string
- host.json pins maxDequeueCount: 5
- APPLICATIONINSIGHTS_CONNECTION_STRING — fetch with:
  az monitor app-insights component show --app appi-traineros --resource-group rg-traineros --query connectionString -o tsv

## Known gotchas
- Two dated things break production silently. The traineros.me domain renews 2027-08-05 — if it lapses, every magic link and reminder email stops resolving. The Azure for Students credit ends at $100 or 12 months, whichever comes first — when it does, Storage stops and the reminder pipeline dies. Set calendar reminders; a doc line is not a warning system.

- `SubscriptionNotFound` from a data-plane command on a fresh subscription usually means the resource provider is unregistered, not that the subscription is missing. Fix: `az provider register --namespace Microsoft.Storage` (and Microsoft.Web, Microsoft.OperationalInsights, Microsoft.Insights).
- `az monitor app-insights component create` without `--workspace` silently creates the classic resource kind, retired Feb 2024. It does not error.
- Queue creates use default key auth, not `--auth-mode login`. Subscription Owner does not grant data-plane access; queues need Storage Queue Data Contributor separately, so `--auth-mode login` fails with AuthorizationPermissionMismatch.- `SubscriptionNotFound` from a data-plane command on a fresh subscription usually means the resource provider is unregistered, not that the subscription is missing. Fix: `az provider register --namespace Microsoft.Storage` (and Microsoft.Web, Microsoft.OperationalInsights, Microsoft.Insights).
- `az monitor app-insights component create` without `--workspace` silently creates the classic resource kind, retired Feb 2024. It does not error.
- Queue creates use default key auth, not `--auth-mode login`. Subscription Owner does not grant data-plane access; queues need Storage Queue Data Contributor separately, so `--auth-mode login` fails with AuthorizationPermissionMismatch.

### Provisioning (#56)
- **`reminders-poison` is a derived name, not a chosen one.** The Functions host moves a message
  to `<queue>-poison` after `maxDequeueCount`, and that string is built by the host. Creating it
  up front is still right — #39's poison handler binds to it, and a binding whose queue is
  created lazily on first failure is a binding nobody has ever seen work — but the name is not
  free. Renaming the queue means renaming `reminders` and letting the host derive the rest.
- **Application Insights is two resources, not one.** Classic App Insights was retired in
  February 2024; every new component is workspace-based and requires a Log Analytics workspace
  to exist first. `az monitor app-insights component create` without `--workspace` does not
  error, it silently creates the deprecated kind. The ticket lists one resource; provision two.
- **Provider registration is the failure that reads like a bug.** On a restricted subscription,
  creating a resource whose provider is `NotRegistered` fails with a message about the resource
  type being unavailable in the region, which sends you looking at the region. Check
  registration first (preflight 3).
- Storage account names take no hyphens and are globally unique, so `sttraineros` is the one
  name here that cannot follow the `rg-` / `log-` / `appi-` convention, and the one that can be
  taken by a stranger.

### Application
- Core Tools forces AZURE_FUNCTIONS_ENVIRONMENT=Development locally, so the
  Resend binding and the #16 startup guard first execute in Azure. If either
  Resend value is missing, the Function App will fail to start — that's the
  guard working.
- Swashbuckle package and CLI are pinned as a pair at 6.6.2. Bump together or not at all.
- No global.json — SDK version is unpinned; CI should pin it.
- EF migrations run as a pipeline step, never on startup.