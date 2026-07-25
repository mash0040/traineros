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

builder.Services.AddDbContext<TrainerOsDbContext>(options => options.UseNpgsql(postgres));
builder.Services.AddSingleton(TimeProvider.System);
builder.Services.AddSingleton<ReminderOccurrenceCalculator>();
builder.Services.AddSingleton<IReminderQueue>(_ => new StorageReminderQueue(storage));

if (!string.IsNullOrEmpty(Environment.GetEnvironmentVariable("APPLICATIONINSIGHTS_CONNECTION_STRING")))
{
    builder.Services.AddOpenTelemetry()
        .UseFunctionsWorkerDefaults()
        .UseAzureMonitorExporter();
}

builder.Build().Run();
