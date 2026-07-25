# TrainerOS

Workout programming and logging for a personal trainer and their clients. Scope lives in [PRODUCT.md](PRODUCT.md); design decisions live in [docs/](docs/).

## Local development

Everything below runs with **no Azure account** (architecture.md §Local dev).

### Prerequisites

- [Docker Desktop](https://www.docker.com/products/docker-desktop/) — runs Postgres and Azurite
- [.NET 8 SDK](https://dotnet.microsoft.com/download/dotnet/8.0)
- [Azure Functions Core Tools v4](https://learn.microsoft.com/azure/azure-functions/functions-run-local)
- [Node.js](https://nodejs.org/) (for the web client)

### 1. Start local services

```sh
docker compose up -d
```

This starts:

| Service | Image | Ports |
|---|---|---|
| Postgres 16 | `postgres:16-alpine` | 5432 |
| Azurite (queue emulation) | `mcr.microsoft.com/azure-storage/azurite` | 10000–10002 |

Local Postgres credentials are `traineros`/`traineros`, database `traineros` — dev-only values, wired into `src/TrainerOS.Api/appsettings.Development.json`. They are not secrets; production configuration is separate (issue #59).

### 2. Run the API

```sh
dotnet watch --project src/TrainerOS.Api
```

Verify the Postgres connection: `GET http://localhost:5216/api/health` returns `200 {"database":"connected"}` (503 if Postgres is down).

### 3. Run the Functions host

`src/TrainerOS.Functions/local.settings.json` is gitignored (Functions convention). Create it with:

```json
{
    "IsEncrypted": false,
    "Values": {
        "AzureWebJobsStorage": "UseDevelopmentStorage=true",
        "FUNCTIONS_WORKER_RUNTIME": "dotnet-isolated",
        "AZURE_FUNCTIONS_ENVIRONMENT": "Development",
        "App:BaseUrl": "http://localhost:5173"
    },
    "ConnectionStrings": {
        "Postgres": "Host=localhost;Port=5432;Database=traineros;Username=traineros;Password=traineros"
    }
}
```

`UseDevelopmentStorage=true` points the host at Azurite's well-known local endpoints; the
scheduler reads schedules from the same Postgres the API uses, and `App:BaseUrl` is the SPA
origin reminder emails link back to. All three are required — the host refuses to start
without them rather than failing silently at the first send. Then:

```sh
cd src/TrainerOS.Functions
func start
```

`ReminderScheduler` runs on a 15-minute timer and creates the `reminders` queue in Azurite on
its first enqueue; `ReminderWorker` picks up from the same queue. In Development the worker
logs email to stdout via the console sender — outside Development it binds Resend and refuses
to start without `Resend:ApiKey` / `Resend:From`.

### 4. Run the web client

```sh
cd src/web
npm install
npm run dev
```

Vite serves the client on http://localhost:5173 and proxies `/api` to the API on port 5216.

After any endpoint or DTO change, run `npm run generate:types` (from `src/web`) — it builds the API, exports `openapi.json`, and regenerates `src/web/src/api/types.gen.ts`.
