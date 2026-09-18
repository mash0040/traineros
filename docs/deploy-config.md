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
| Provisioned | **Yes.** Plan, web app, Neon project and Function App exist, first deployed 7 August 2026. Both pipelines now deploy automatically on push to `main`. |
| Plan SKU | Started at **F1**, now **B1** — the free tier's daily CPU quota ran out during setup, before any real traffic. See §Known gotchas → Deploying. |
| Custom domain | **Bound.** `traineros.me` at the root, A record → `52.237.22.139`, managed certificate, SNI SSL. `App:BaseUrl` is `https://traineros.me` on both hosts. |
| Owner | The human. The `az` commands below are the record of what was created. |

### Resources

| Resource | Name | Region | SKU / tier | Why |
|---|---|---|---|---|
| App Service plan | `plan-traineros` | `canadacentral` | **B1**, Linux (created as F1) | Started on the ladder's first rung; F1's 60 CPU-minutes/day ran out during setup, so it is B1 now — the ladder working as designed, not a surprise. Must match #56's region or every queue call from the API crosses a region boundary. |
| Web app | `app-traineros` *(globally unique — see note)* | `canadacentral` | `DOTNETCORE:8.0` | Serves the API and the SPA out of one wwwroot (architecture.md §Deployment shape). |
| Function App | `func-traineros` | `canadacentral` | Linux, **on `plan-traineros`** (B1 Dedicated — not Consumption) | Scheduler and worker (#58). Deploys from its own workflow and never touches the schema — see §One migrator. Sharing the web app's plan is why the Function App adds nothing to the bill, and why it is not subject to Consumption's deployment shape. |
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

`www.traineros.me` is bound too, on the same inbound IP with its own managed certificate, and
serves the identical site. That makes it a **second origin**, which is a problem rather than a
convenience: the session cookie sets no `Domain` (it is deliberately host-only, api.md §Auth), so
a sign-in at `www.` does not exist at the apex, and `App:BaseUrl` can only name one of the two.

The apex is canonical. `UseCanonicalHost` (#158, first in the API's pipeline) is what enforces
that: any request whose host begins with `www.` gets a **301** to the same path and query on the
host with the prefix stripped, before the rate limiter or any session lookup. The rule is the
prefix itself, not a list of known hosts — so `localhost` and `app-traineros.azurewebsites.net`
are untouched by construction. **That second exemption is load-bearing:** the pipeline's smoke
check requests `https://app-traineros.azurewebsites.net/` and asserts the SPA shell comes back as
`text/html`. Redirect that host and every deploy fails. A test pins it.

The redirect always targets `https://`, regardless of the inbound scheme. App Service terminates
TLS at the front end and forwards to Kestrel over plain HTTP, and this app does not run
`UseForwardedHeaders`, so `Request.Scheme` reads `http` in production — echoing it would bounce a
visitor out of HTTPS on an HTTPS-only site.

Root domains cannot be CNAMEs, so the binding pins a literal IP. That IP is stable for the life
of the web app but is **not** guaranteed across a delete-and-recreate: if `app-traineros` is
ever rebuilt, re-read the inbound IP and update the A record, or the domain resolves to a site
that no longer exists. The `azurewebsites.net` hostname keeps working alongside it, which is why
the pipeline's smoke check still targets it — one less thing depending on DNS, and a host the
`www.` redirect above deliberately leaves alone.

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

Repository settings → Secrets and variables → Actions. None of these goes in the repo
(architecture.md: "No secrets in repo").

| Secret | Used by | Value | Read it with |
|---|---|---|---|
| `AZURE_WEBAPP_PUBLISH_PROFILE` | `deploy-app.yml` | The whole XML file, pasted | `az webapp deployment list-publishing-profiles -n app-traineros -g rg-traineros --xml` |
| `POSTGRES_CONNECTION_STRING` | `deploy-app.yml` | Neon **direct** (non-pooler) string, Npgsql key-value format | Neon console, then convert per §Known gotchas |
| `AZURE_FUNCTIONAPP_PUBLISH_PROFILE` | `deploy-functions.yml` | The whole XML file, pasted | `az functionapp deployment list-publishing-profiles -n func-traineros -g rg-traineros --xml` |

Both pipelines authenticate the same way, with a publish profile. Neither uses a service
principal, and that is a constraint rather than a preference — see §Why there is no service
principal.

**SCM basic auth must be enabled on each site for its profile to work.** It is off by default,
and the deploy fails with a 401 that reads like a bad secret. `app-traineros` was switched on
during #57; `func-traineros` was still `allow: false` when #58 was written, so it needs the same
command:

```bash
az resource update -g rg-traineros --namespace Microsoft.Web \
  --resource-type basicPublishingCredentialsPolicies \
  --name scm --parent sites/func-traineros --set properties.allow=true
```

#### Re-examined in #128, and kept — with an expiry date

The deploy step's repeated opaque 500s were the reason to look again, and they turn out not to
be evidence against the credential. **Publish-profile auth fails as 401 or 403, not 500.** A 500
comes from the far side of the door, and this environment had a documented reason to produce
them in exactly that window: F1's CPU quota reached `usageState: Exceeded` during setup, which
disables the site *including its SCM endpoint* (§What F1 did not do). That is gone on B1. So the
next run tests the packaging fix against a plan that is no longer disabled, and swapping the
credential in the same change would only make a second failure ambiguous.

What is real is the clock. SCM basic auth is deprecated: it is **off by default** on new web
apps, which is why creating this one needed the `basicPublishingCredentialsPolicies` override
above. That override is a platform default being held open by hand — a tenant policy or a future
default can close it, and when it does the pipeline fails with a 401 that reads like a bad
secret rather than like a withdrawn mechanism. The publish profile is therefore a dated
decision, not a permanent one.

#### Why there is no service principal

Not a deferral. **The tenant refuses to create one.** `az ad app create` fails with
*Insufficient privileges to complete the operation*, this is an Azure for Students subscription
on a personal account, and there is no tenant admin to ask. App registration is an Entra
directory permission, not a subscription one, so owning the subscription does not help and no
`az role assignment` can grant it.

That closes the OIDC path completely, for both workflows, until the account changes — a
different tenant, a work or school directory, or an admin who can flip *Users can register
applications*. It is worth re-testing whenever any of those changes, because everything else
about the migration is still true: federated credentials remove a stored secret, and the
publish-profile mechanism is on a deprecation clock this project does not control.

**What the constraint actually costs is `az`, not deployment.** The Azure CLI can only
authenticate as a principal, so no `az` command can run in either pipeline. Anything that
reaches for ARM — `az functionapp deployment source config-zip`, `az functionapp restart`,
`az functionapp function list` — is unavailable. Everything those commands do over the SCM
endpoint is still reachable, because the publish profile *is* an SCM credential. That
distinction is what makes the Functions pipeline possible (§Functions pipeline shape); it was
worth establishing rather than assuming, because "needs `az`" and "needs ARM" are not the same
requirement and only the second one is real.

The residual risk to keep in view: both workflows now depend on SCM basic auth, and the day
Azure withdraws it — or a policy closes the override — **both** pipelines fail at once with a
401, and neither has a fallback while the tenant blocks registration. That is the single point
of failure this environment has, and it is written down because there is nothing to do about it
today.
Managed identity (#59) was evaluated and declined for the same reason plus a value argument. The tenant block on app registration makes the identity path uncertain — role assignment is a different permission than app registration and may or may not be permitted — but the benefit is thin regardless: the credentials managed identity would replace already live in Azure app settings rather than anywhere they could leak from. The project's real credential risk is that both pipelines depend on SCM basic auth with no fallback, which managed identity does not address. Worth revisiting if the subscription moves to a tenant where app registration is permitted.

### Pipeline shape

`.github/workflows/deploy-app.yml`, on push to `main`. Three jobs, and the split is the point:

1. **build** — .NET tests and client tests, then `npm run build`, then `dotnet publish`, then
   Vite's `dist/` copied into `publish/wwwroot`. That copy is what "same-origin" means in
   practice. Then `dotnet ef migrations bundle` produces a self-contained `efbundle`, and
   `publish/` is zipped into `deploy.zip` — the artifact the deploy job hands to Kudu unchanged.
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

#### Packaging, and the two bugs it does not have (#128)

The manual deploy found two packaging bugs (§Known gotchas → Deploying) and the pipeline was
read against both. **It has neither, and both were structural rather than lucky:** the jobs run
on `ubuntu-latest`, so nothing here is PowerShell, and the SPA copy was already written as
`cp -r src/web/dist/. publish/wwwroot/`, which copies a tree as a tree. What #128 changed is
that neither is true *by accident* any more:

- **The zip is built here, not by the deploy action.** `zip -qr ../deploy.zip .` out of
  `publish/`, and a verification step reads the entry names back with `unzip -Z1` and fails the
  build if any contains a backslash. The bug is a property of the zipping tool, so the fix is to
  pin the tool and assert the property — not to rely on which runner OS the job happens to use.
  Deploying the zip rather than the folder also shrinks the artifact round trip to one file.
- **The wwwroot check resolves the SPA's own references.** `test -f index.html` is exactly the
  check a flattened copy passes: the shell is at the root either way, and it is the hashed
  bundles under `assets/` that moved. The step now reads the `/assets/…` paths out of
  `index.html` and asserts each one exists at the path the shell will ask for, and fails if
  `index.html` referenced none at all rather than passing vacuously.

Neither guard is theoretical: both were run against a real flattened copy and a real
backslash-entry zip before being written down.

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

### Functions pipeline shape (#58)

`.github/workflows/deploy-functions.yml`, on push to `main`. Two jobs — build then deploy — and
**no migrate job at all**, which is the rule above expressed as an absence. Its `concurrency`
group is `deploy-functions`, deliberately not shared with `deploy-app`.

Both workflows fire on the same push and neither waits for the other. That is the point of the
split: a CSS change has no business restarting the scheduler, and a change to the 15-minute
timer has no business waiting on the client test suite.

**Build** runs the whole `TrainerOS.Tests` suite rather than a Functions-only filter. The
project references Api, Domain and Functions together, and the scheduler's behaviour is asserted
through the same Domain code the endpoints use; splitting it would let a Domain change deploy
the scheduler while the tests covering it ran in the other pipeline. Then `dotnet publish`
(portable, no `--runtime`: `worker.config.json` declares `defaultExecutablePath: dotnet`, so the
Linux host runs the same framework-dependent payload a Windows box produces), then `zip` and the
package verification below.

**The package is verified before it is uploaded**, on the same principle as the App Service
pipeline — assert the properties, do not inherit them:

| Check | The failure it catches |
|---|---|
| No backslashes in entry names | The `Compress-Archive` bug in §Deploying, if this ever runs anywhere but Linux |
| `host.json`, `functions.metadata`, `worker.config.json`, `extensions.json`, `TrainerOS.Functions.dll` at the **package root** | A zip rooted one directory too deep, which unpacks into an app that starts and indexes nothing |
| Every `hintPath` in `extensions.json` resolves inside the package | A lost `.azurefunctions/` directory — a host that starts cleanly, binds nothing to the queue, and sends no reminders. Silence, not a crash |
| `functions.metadata` lists all three of `ReminderScheduler`, `ReminderWorker`, `ReminderPoisonHandler` | A `[Function]` attribute lost to a refactor. This is the **only** place the three names are asserted — see §What this pipeline verifies, and what it does not |

**Deploy uses `Azure/functions-action@v1` with the publish profile, and that is the whole reason
this pipeline exists at all.** The obvious reading of §Deploying is that the working path needs
`az functionapp deployment source config-zip`, and `az` needs a service principal the tenant
will not create (§Why there is no service principal) — which would have made #58 impossible.
That reading is wrong, and the action's source is where it comes apart:

- Given a `publish-profile`, the action takes its **SCM** code path and *makes no ARM call at
  all* — it builds a Kudu client straight from the profile and reads app settings through
  `/api/settings`. Its own log line for this is "GitHub Action will not perform resource
  validation."
- On that path it posts to `https://<scm>/api/zipdeploy` unless `sku` is `flexconsumption`.
  That is **the same endpoint `config-zip` posts to**. The Oryx failure in §Deploying belongs to
  OneDeploy — `/api/publish`, which is what `az functionapp deploy --type zip` uses — and this
  path never touches it.

So the verified mechanism and the available credential are compatible after all; what the
tenant blocks is `az`, not zipdeploy. The workflow still checks `WEBSITE_RUN_FROM_PACKAGE` is
`1` before deploying — an app setting a human can clear from the portal without ever seeing the
workflow — reading it through Kudu's `/api/settings` rather than ARM.

**One non-obvious input:** `scm-do-build-during-deployment` and `enable-oryx-build` are passed as
**empty strings, not `false`**. Their action defaults are the *string* `'false'`, which is a
value rather than an absence: on the SCM path the action writes both settings into the live app
through Kudu, polls up to 100 s each for propagation, and then deletes them afterwards if they
had not been set before. The empty string is the documented bypass. Neither setting affects
zipdeploy in any case — they were tried against OneDeploy and did not stop Oryx.

**There is no post-deploy smoke check.** `deploy-app.yml` can `curl` `/api/health`; none of the
three functions is HTTP-triggered, so this pipeline has no equivalent. A probe was tried — read
the master key from Kudu at `/api/functions/admin/masterkey`, then poll the host's admin API at
`/admin/functions` until all three names appear — and it was removed rather than debugged, for
two reasons that compound. The credential path did not work: the deploy itself succeeds on the
same basic-auth pair, but the master-key read failed, and chasing that is effort spent on a
check whose ceiling was already low. And the ceiling really is low: the three function names are
**identical before and after a deploy**, so a host still serving the previous package answers
the probe exactly like one that swapped. It could never have proved what it looked like it was
proving.

#### What this pipeline verifies, and what it does not

Stated plainly because the difference is invisible from a green checkmark.

**Verified:**

| Claim | By what |
|---|---|
| The build compiles and the whole `TrainerOS.Tests` suite passes | `dotnet test` in **build** |
| The package has the right shape — root layout, no backslash entries, every `extensions.json` hint-path present | The package verification step in **build** |
| All three functions were **built** into the package | `functions.metadata` assertion in **build** |
| The app is still in run-from-package mode | Kudu `/api/settings` check in **deploy** |
| Kudu accepted the package | `functions-action` polls the deployment to completion and throws on failure, which fails the job |

**Not verified — and this is the honest gap:**

- **The host started after the deploy.** Nothing in this pipeline talks to the running host. The
  deploy step's success means Kudu unpacked and mounted the package, not that the worker process
  came back up.
- **Consequently, a config-guard failure is invisible here.** `Program.cs` throws at startup on a
  missing `ConnectionStrings:Postgres`, `AzureWebJobsStorage`, `App:BaseUrl` or
  `Notifications:PauseTokenKey` (the last is #40's signed pause link, which the reminder cannot
  be built without), and `ResendOptions` validates `Resend:ApiKey` / `Resend:From` the same way
  (#16). Core Tools forces `Development` locally, so every one of those first executes in Azure
  (§Application). A host that cannot start **deploys perfectly**: the pipeline is green, the
  deployment record is clean, and reminders silently stop sending. That failure surfaces as a
  client not receiving an email — via App Insights, or via a human noticing — and never as a red
  pipeline. It is exactly the shape of failure the rest of this file works to avoid, and the one
  place the pipeline cannot see.
- **That the running host swapped to the new package.** Kudu's deployment record is the only
  evidence, and nothing reads it back off the mount.

Closing the first two would need a probe the deployed host answers — which needs either a
working master-key path or an HTTP-triggered health function of our own — and closing the third
would need a build marker in the package read back from the running host. Neither is worth the
machinery at one environment, but **neither is covered today**, and a green run on this workflow
should not be read as "reminders are sending." The check that would catch it is the App Insights
alert on the poison-queue function (notifications.md §Observability) plus the fact that a host
which never starts also never logs.

## App Service (API)
- ConnectionStrings:Postgres
- Resend:ApiKey
- Resend:From  (TrainerOS <noreply@traineros.me>)
- Notifications:PauseTokenKey  (must be IDENTICAL to the Function App's value)
- App:BaseUrl = https://traineros.me  (the domain is bound — §Custom domain. Must stay identical to the Function App's copy: every magic link and reminder footer is built from it)
- Seed__TrainerEmail / Seed__TrainerPassword  (first boot only; seeds the trainer)
- Health check path is /api/health, NOT /health  (available on B1; the pipeline's post-deploy smoke check hits the same endpoint either way)
- APPLICATIONINSIGHTS_CONNECTION_STRING — fetch with:
  az monitor app-insights component show --app appi-traineros --resource-group rg-traineros --query connectionString -o tsv

## Function App
- ConnectionStrings:Postgres
- Resend:ApiKey 
- Resend:From (TrainerOS <noreply@traineros.me>)
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
which is the reason they are written down rather than remembered. The first two are packaging
bugs; the pipeline was read against both in #128 and has neither, and now asserts as much —
see §Pipeline shape → Packaging.

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

  **The distinction is the endpoint, not the tool** — established in #58 and worth stating
  because it is what makes the pipeline possible. `az functionapp deploy --type zip` posts to
  OneDeploy at `/api/publish`, which is where the forced Oryx build lives. `config-zip` posts to
  the older `/api/zipdeploy`, which with run-from-package mounts the package as-is and builds
  nothing. Anything that posts to `/api/zipdeploy` works, including
  `Azure/functions-action@v1` authenticated with a publish profile — so this finding is about
  two Kudu endpoints, and reads as being about two `az` commands only because that is how it was
  first met.
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