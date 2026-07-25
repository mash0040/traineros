using Azure.Monitor.OpenTelemetry.Exporter;
using Microsoft.Azure.Functions.Worker;
using Microsoft.Azure.Functions.Worker.Builder;
using Microsoft.Azure.Functions.Worker.OpenTelemetry;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Hosting;
using OpenTelemetry;

using TrainerOS.Domain.Data;
using TrainerOS.Domain.Notifications;
using TrainerOS.Functions;

var builder = FunctionsApplication.CreateBuilder(args);

builder.ConfigureFunctionsWebApplication();

// Fail fast at startup rather than on the first tick: a scheduler that starts happily and
// then throws every 15 minutes is a worse failure than one that never starts.
var postgres = builder.Configuration.GetConnectionString("Postgres")
    ?? throw new InvalidOperationException(
        "ConnectionStrings:Postgres is not configured — the scheduler has no notification_schedules to read.");
var storage = builder.Configuration["AzureWebJobsStorage"]
    ?? throw new InvalidOperationException(
        "AzureWebJobsStorage is not configured — the scheduler has nowhere to enqueue reminders.");
var appBaseUrl = builder.Configuration["App:BaseUrl"]
    ?? throw new InvalidOperationException(
        "App:BaseUrl is not configured — reminder emails cannot be built without the SPA origin.");
var pauseTokenKey = builder.Configuration["Notifications:PauseTokenKey"]
    ?? throw new InvalidOperationException(
        "Notifications:PauseTokenKey is not configured — reminders must carry a signed pause link. "
        + "It must be the same key the API validates with.");

builder.Services.AddDbContext<TrainerOsDbContext>(options => options.UseNpgsql(postgres));
builder.Services.AddSingleton(TimeProvider.System);
builder.Services.AddSingleton<ReminderOccurrenceCalculator>();
builder.Services.AddSingleton<IReminderQueue>(_ => new StorageReminderQueue(storage));
builder.Services.AddSingleton(new AppBaseUrl(appBaseUrl));
builder.Services.AddSingleton(new PauseTokenSigner(pauseTokenKey));

// Same branch as the API's Program.cs: console in dev so mail is followable from stdout,
// Resend everywhere else, config-validated at startup.
if (builder.Environment.IsDevelopment())
{
    builder.Services.AddSingleton<INotificationSender, ConsoleNotificationSender>();
}
else
{
    builder.Services.AddResendNotificationSender(builder.Configuration);
}

if (!string.IsNullOrEmpty(Environment.GetEnvironmentVariable("APPLICATIONINSIGHTS_CONNECTION_STRING")))
{
    builder.Services.AddOpenTelemetry()
        .UseFunctionsWorkerDefaults()
        .UseAzureMonitorExporter();
}

var host = builder.Build();

// The #16 guard, carried over to the worker's host: a reminder pipeline whose last mile is
// unwired should die at startup, not discover it 15 minutes later with a row already marked
// 'failed'.
if (!builder.Environment.IsDevelopment() && host.Services.GetService<INotificationSender>() is null)
{
    throw new InvalidOperationException(
        "No INotificationSender registered. Non-Development environments require the production "
        + "sender binding (Resend) — refusing to start with reminder email silently unwired.");
}

host.Run();
