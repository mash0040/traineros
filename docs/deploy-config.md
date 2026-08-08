# Deploy configuration (for #56–59)

## Azure resources (#56)

Early scope, per the cost-ladder decision in architecture.md §Deployment shape: provision the
substrate first so subscription and quota problems surface here rather than at deploy week.
App Service and the database were deliberately absent from this round — they arrived in #57,
when the pipeline needed a target.

Method is clickops, per the PRODUCT.md non-goal on IaC. The `az` commands below are a **record
of what was created**, not a deployment mechanism: there is no state file, nothing re-runs them,
and the portal is an equally valid way to produce the same resources. They are written down
because "documented config" at one environment means someone can reproduce it by hand.

### Status

| | |
|---|---|
| Provisioned | **Yes.** All of it, in `canadacentral`: resource group `rg-traineros`, storage `sttraineros` with both queues, Log Analytics `log-traineros`, App Insights `appi-traineros`. |
| Also live | The #57/#58 half: App Service plan `plan-traineros` (created F1, promoted to B1), web app `app-traineros`, Function App `func-traineros` — see §App Service and database (#57). |
| Custom domain | `traineros.me` bound at the root, A record → `52.237.22.139`, App Service managed certificate, SNI SSL. |
| Preflight | Ran clean before anything was created — no quota, policy, or provider block on this subscription. The six checks below are kept as method, not as an open task. |

### Preflight: can this subscription provision at all?

The ticket's first item, and the reason it is first: quota and policy failures on this account
are a known risk, and the expensive version of finding out is at deploy week with a pipeline
half-written. All six were run before anything was created, and none of them blocked; they are
kept because the next environment — or the next subscription — gets checked the same way.

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

- Storage account actually created: `sttraineros` — the preferred name was available.

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

- App Insights connection string recorded in App Service / Function App config: `both hosts are configured`

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

**All-in, now that #57's half is live:** the B1 plan is ~$13/month and Neon's free tier is $0,
so the whole environment runs at roughly **$13–14/month**. That is the promoted rung of the
ladder, reached on day one rather than never — architecture.md's ~$28 figure assumed B1 *plus*
Azure Postgres Flexible, and Neon is what keeps the second half of that off the bill.

## App Service and database (#57)

The deploy target, provisioned at the point the pipeline needs one. Same method as §Azure
resources: clickops, and the commands are a record of what was created.

### Status

| | |
|---|---|
| Provisioned | **Yes.** Plan, web app, Neon project and Function App exist and have been deployed to manually (#57/#58). Date: `<fill in>`. |
| Plan SKU | Started at **F1**, now **B1** — the free tier's daily CPU quota ran out during setup, before any real traffic. See §Known gotchas → Deploying. |
| Custom domain | **Bound.** `traineros.me` at the root, A record → `52.237.22.139`, managed certificate, SNI SSL. `App:BaseUrl` is `https://traineros.me` on both hosts. |
| Owner | The human. The `az` commands below are the record of what was created. |

### Resources

| Resource | Name | Region | SKU / tier | Why |
|---|---|---|---|---|
| App Service plan | `plan-traineros` | `canadacentral` | **B1**, Linux (created as F1) | Started on the ladder's first rung; F1's 60 CPU-minutes/day ran out during setup, so it is B1 now — the ladder working as designed, not a surprise. Must match #56's region or every queue call from the API crosses a region boundary. |
| Web app | `app-traineros` *(globally unique — see note)* | `canadacentral` | `DOTNETCORE:8.0` | Serves the API and the SPA out of one wwwroot (architecture.md §Deployment shape). |
| Function App | `func-traineros` | `canadacentral` | Linux | Scheduler and worker (#58). Deploys from its own workflow and never touches the schema — see §One migrator. |
| Postgres | Neon project `traineros` | closest Neon region to Toronto | Free | Second rung. Not an Azure resource — deliberately, per the ladder. |

**The web app name is globally unique** (`<name>.azurewebsites.net`), like the storage account.
`app-traineros` is the preferred name and `AZURE_WEBAPP_NAME` in the workflow; if it is taken,
pick another, change it in **both** places, and record it here:

- Web app actually created: `app-traineros`

```bash
LOC=canadacentral
RG=rg-traineros

# --is-linux is not optional: Windows plans are the default and cost more for the same app.
az appservice plan create -n plan-traineros -g $RG -l $LOC --sku F1 --is-linux

az webapp create -n app-traineros -g $RG -p plan-traineros --runtime "DOTNETCORE:8.0"

# The pipeline authenticates with a publish profile, which is SCM basic auth. It is off by
# default on new web apps, and the deploy fails with a 401 that reads like a bad secret.
az resource update -g $RG --namespace Microsoft.Web --resource-type basicPublishingCredentialsPolicies 
  --name scm --parent sites/app-traineros --set properties.allow=true

# Promotion, run after F1's daily CPU quota was exhausted during setup. ~$13/mo, and the point
# at which the honest-cost figure in architecture.md starts applying.
az appservice plan update -n plan-traineros -g $RG --sku B1
```

Postgres is created in the Neon console (no CLI here — it is not an Azure resource): one
project, one database, free tier, region chosen for proximity to Toronto. Neon hands back URI
strings; both consumers need the key-value conversion in §Known gotchas, and the two strings
are not interchangeable — the **direct** string goes in the `POSTGRES_CONNECTION_STRING` GitHub
secret that the migration bundle uses, the **pooled** one in the `ConnectionStrings:Postgres`
app setting on both hosts.

### Custom domain

`traineros.me` is bound at the **root** (apex), which is what forces the shape of the DNS:

| | |
|---|---|
| Record | `A` → `52.237.22.139` (the web app's inbound IP) |
| Verification | App Service will not accept an apex binding on an A record without the `asuid.<domain>` TXT record carrying the custom-domain verification ID |
| Certificate | App Service **managed certificate** — free, auto-renewing, and enough for one apex host |
| TLS binding | **SNI SSL** (not IP-based, which costs an IP and buys nothing here) |

Root domains cannot be CNAMEs, so the binding pins a literal IP. That IP is stable for the life
of the web app but is **not** guaranteed across a delete-and-recreate: if `app-traineros` is
ever rebuilt, re-read the inbound IP and update the A record, or the domain resolves to a site
that no longer exists. The `azurewebsites.net` hostname keeps working alongside it, which is why
the pipeline's smoke check still targets it — one less thing depending on DNS.

The managed certificate renews itself, so the dated risk here is the **domain registration**, not
the cert: `traineros.me` renews 2027-08-05, and if it lapses every magic link and reminder email
stops resolving (§Known gotchas).

### What F1 did not do, and why the plan is B1

Kept as the record of the promotion: the ladder said "start free, climb if the free tier bites",
and it bit within the first day. What each hole cost, and where it stands now:

- **60 CPU-minutes a day — the one that forced the promotion.** Exhausted during setup, before
  a single real request. It presents as 503s everywhere and a 403 "Site Disabled" log stream,
  which reads like a crashed app; the tell is `usageState: Exceeded`, not the application logs.
  Gone on B1.
- **No custom domain.** F1 served `*.azurewebsites.net` only. Resolved by the promotion and
  then done: `traineros.me` is bound (§Custom domain) and `App:BaseUrl` is that host on both
  hosts.
- **No Health check feature.** Requires Basic or higher, so on F1 the `/api/health` path was
  configuration the platform ignored. Available now on B1; enabling it is a portal toggle, and
  the path is `/api/health`, not `/health`. Either way the pipeline's post-deploy smoke check
  hits the same endpoint, so a deploy that comes up unable to reach Postgres still fails loudly.
- **No Always On.** The site unloaded when idle and the first request paid the cold start,
  which is why the smoke check retries rather than asserting on the first response. B1 supports
  Always On. Neon's free tier still autosuspends regardless, so the first *database* query
  after a quiet period pays its own wake-up — keep the retries.
- Watch for spam-folder delivery. It was written down as the likely first reason to climb off
  F1; the CPU quota got there first, so this is now purely a deliverability question — the lever
  is the verified from-domain in Resend, not the App Service tier.


### GitHub secrets the pipeline needs

Repository settings → Secrets and variables → Actions. Both are secrets; neither goes in the
repo (architecture.md: "No secrets in repo").

| Secret | Value | Read it with |
|---|---|---|
| `AZURE_WEBAPP_PUBLISH_PROFILE` | The whole XML file, pasted | `az webapp deployment list-publishing-profiles -n app-traineros -g rg-traineros --xml` |
| `POSTGRES_CONNECTION_STRING` | Neon **direct** (non-pooler) string, Npgsql key-value format | Neon console, then convert per §Known gotchas |

Publish profile rather than a service principal with OIDC: it is the clickops-shaped option for
one environment, and it is a credential to rotate rather than an identity to federate. #59 owns
managed identity where it is supported; a GitHub runner deploying into App Service is not one of
those places.

### Pipeline shape

`.github/workflows/deploy-app.yml`, on push to `main`. Three jobs, and the split is the point:

1. **build** — .NET tests and client tests, then `npm run build`, then `dotnet publish`, then
   Vite's `dist/` copied into `publish/wwwroot`. That copy is what "same-origin" means in
   practice. Then `dotnet ef migrations bundle` produces a self-contained `efbundle`.
2. **migrate** — runs `efbundle --connection "$POSTGRES_CONNECTION_STRING"`. Migrations are a
   pipeline step and never on startup: startup migrations across multiple instances race, and
   the day this plan scales out would be the first time anyone found out.
3. **deploy** — `needs: migrate`, so a failed migration stops the deploy dead. `efbundle` exits
   non-zero on any migration error, which is the whole mechanism. Migration 002 adds a unique
   index that can fail on pre-existing rows (#98). That was harmless while production was empty;
   it stopped being empty the moment the app went live, which is the case the ordering was put
   here for — the day a migration can fail on real rows, the answer is a red pipeline and not a
   green deploy of code that assumes the index is there.

Schema goes first, code second: new code against old schema is the combination that takes the
site down, and old code against new schema survives the two minutes in between. `concurrency`
queues runs rather than cancelling them, so two pushes never apply migrations at the same time.

The SDK is pinned in the workflow (`8.0.x`) rather than by a `global.json`, per §Application
below.

### One migrator, and why it is a rule rather than a lock

**`deploy-app.yml` is the only workflow that applies migrations.** #58's Functions pipeline
fires on the same push to `main`; it builds and deploys the Function App and touches the schema
never. Neither host migrates on startup either — there is no `Migrate()` or `EnsureCreated()`
anywhere in `src/`, only in tests.

The rule matters because EF Core 8 takes no database lock while migrating (`IMigrationsDatabaseLock`
arrived in EF Core 9). Two `efbundle` runs against one database would both read
`__EFMigrationsHistory`, both conclude the same migration is pending, and both start applying
it. The loser dies mid-DDL with something like `relation already exists` — loud, but pointing
at the schema instead of at the pipeline that raced it.

Sharing one `concurrency` group between the two workflows looks like the fix and is not: GitHub
keeps exactly one *pending* run per group and cancels the older one when a newer arrives. Two
quick pushes here would silently cancel a queued Functions deploy, and a Functions change that
never deployed is a worse failure than the one being prevented — it fails by being absent.

What the rule leaves on the table is a window where the Function App deploys while this
pipeline is still migrating, so the worker briefly runs new code against the old schema. The
queue already covers that: the worker throws, the message goes back, and `maxDequeueCount: 5`
gives it four more attempts after the schema lands. A reminder is late by minutes; nothing is
lost, which is the same property notifications.md leans on everywhere else.

If #58 ever does need to apply migrations, the two workflows must move to a shared concurrency
group and accept the cancelled-pending-run trade-off — that is the point at which it becomes
the lesser problem.

## App Service (API)
- ConnectionStrings:Postgres
- Resend:ApiKey
- Resend:From  (noreply@traineros.me)
- Notifications:PauseTokenKey  (must be IDENTICAL to the Function App's value)
- App:BaseUrl = https://traineros.me  (the domain is bound — §Custom domain. Must stay identical to the Function App's copy: every magic link and reminder footer is built from it)
- Seed__TrainerEmail / Seed__TrainerPassword  (first boot only; seeds the trainer)
- Health check path is /api/health, NOT /health  (available on B1; the pipeline's post-deploy smoke check hits the same endpoint either way)
- APPLICATIONINSIGHTS_CONNECTION_STRING — fetch with:
  az monitor app-insights component show --app appi-traineros --resource-group rg-traineros --query connectionString -o tsv

## Function App
- ConnectionStrings:Postgres
- Resend:ApiKey 
- Resend:From (noreply@traineros.me)
- Notifications:PauseTokenKey  (same value as App Service)
- App:BaseUrl = https://traineros.me  (same value as the App Service — the two must never disagree: this host mints the pause links the API validates)
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

- Neon connection strings are URI format (postgresql://user:pass@host/db?sslmode=require). Npgsql needs key-value: Host=...;Database=...;Username=...;Password=...;SSL Mode=Require;Trust Server Certificate=true. Convert both the pooled and direct strings. A URI passed to Npgsql fails with KeyNotFoundException, which reads like a code bug rather than a format problem.
- `dotnet ef database update` ignores ConnectionStrings__Postgres — the design-time factory (#17) hardcodes the docker-compose dev connection, so a migration step without an explicit `--connection` reports success against the wrong database. The pipeline must pass it explicitly.
- Use the direct (non-pooler) string for migrations, the pooled one for the app. Pooled connections don't handle some DDL cleanly.

### Deploying (#57, #58)

Found during the first manual deploy. Each one presents as a different failure than it is,
which is the reason they are written down rather than remembered.

- **`Compress-Archive` produces a zip Kudu cannot unpack.** PowerShell writes Windows
  backslashes as the path separator inside the zip entries; Kudu's rsync on the Linux side
  reads the backslash as part of the filename, so every non-root file fails with
  `Invalid argument (22)` and the deploy returns an opaque 400. Use
  `tar -a -c -f deploy.zip -C publish *` instead.
- **`Copy-Item src/web/dist/* publish/wwwroot/ -Recurse` flattens the folder structure.** The
  contents of `assets/` land directly in `wwwroot/`, so the SPA 404s on its own bundles — the
  shell loads and nothing else does. Drop the wildcard:
  `Copy-Item src/web/dist publish/wwwroot -Recurse`.
- **F1's 60 CPU-minutes/day quota was exhausted during setup**, before any real traffic. The
  symptom is 503 on every request and 403 "Site Disabled" on the log stream, which reads like a
  crashed app and sends you into the application logs. It is not the app: check
  `usageState` for `Exceeded`. Resolved by promoting the plan to B1.
- **Linux Function Apps: `az functionapp deploy --type zip` triggers an Oryx build** that fails
  on an already-published .NET package, with an empty build log to explain it. Setting
  `SCM_DO_BUILD_DURING_DEPLOYMENT=false` and `ENABLE_ORYX_BUILD=false` did **not** stop it. The
  working path is `WEBSITE_RUN_FROM_PACKAGE=1` plus `az functionapp deployment source config-zip`.
- **After a Functions deploy, the functions do not appear in `az functionapp function list`
  until the app is restarted.** An empty list is not necessarily a failed deploy. Restart, then
  list again before believing it.

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
- No global.json — SDK version is unpinned; CI pins it (`DOTNET_VERSION: 8.0.x` in
  `.github/workflows/deploy-app.yml`). A local `dotnet build` still uses whatever SDK is
  installed, so "works here" and "builds in CI" are still two different claims.
- EF migrations run as a pipeline step, never on startup.
- `dotnet ef migrations bundle` resolves Microsoft.EntityFrameworkCore.Design from the
  **startup** project, where PrivateAssets stops Domain's reference from reaching. Without a
  direct reference in TrainerOS.Api it fails with `Could not load file or assembly
  'Microsoft.EntityFrameworkCore.Design'` — which reads as a corrupt install, not a missing
  reference. Added in #57; the two versions must stay in step.
- The bundle is built `--self-contained --target-runtime linux-x64`, which is what lets the
  migrate job run it with no .NET installed. It also means the bundle is a Linux binary: it
  cannot be run from a Windows dev box to check a migration by hand (build a `win-x64` one for
  that), and the executable bit does not survive an upload/download artifact round trip.
- The SPA is served by the API's own static-file middleware with a `/api` carve-out
  (`SpaHosting.cs`): unmatched non-API paths return index.html so pasted `/verify?token=` links
  work, while unmatched `/api` paths keep the JSON error envelope. An empty `wwwroot` — the
  state of any source checkout — makes the app answer every client route with a JSON 404,
  which is also what a deploy that lost the SPA looks like.