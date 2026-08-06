# Deploy configuration (for #56–59)

## App Service (API)
- ConnectionStrings:Postgres
- Resend:ApiKey
- Resend:From  (must match a verified domain in Resend)
- Notifications:PauseTokenKey  (must be IDENTICAL to the Function App's value)
- App:BaseUrl  (SPA origin — used in magic-link and pause-link emails)
- Seed__TrainerEmail / Seed__TrainerPassword  (first boot only; seeds the trainer)
- Health check path is /api/health, NOT /health

## Function App
- ConnectionStrings:Postgres
- Resend:ApiKey / noreply@traineros.me
- Notifications:PauseTokenKey  (same value as App Service)
- App:https://traineros.me
- Queue Storage connection string
- host.json pins maxDequeueCount: 5
- Renewal date: 2027-08-05

## Known gotchas
- Core Tools forces AZURE_FUNCTIONS_ENVIRONMENT=Development locally, so the
  Resend binding and the #16 startup guard first execute in Azure. If either
  Resend value is missing, the Function App will fail to start — that's the
  guard working.
- Swashbuckle package and CLI are pinned as a pair at 6.6.2. Bump together or not at all.
- No global.json — SDK version is unpinned; CI should pin it.
- EF migrations run as a pipeline step, never on startup.