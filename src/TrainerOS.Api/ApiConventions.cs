using System.Text.Json;
using System.Text.Json.Serialization;
using Microsoft.AspNetCore.Diagnostics;
using Microsoft.AspNetCore.WebUtilities;

namespace TrainerOS.Api;

public sealed record ApiError(ApiErrorDetail Error)
{
    public static ApiError Create(string code, string message) => new(new ApiErrorDetail(code, message));
}

public sealed record ApiErrorDetail(string Code, string Message);

// The three response shapes that used to be anonymous objects. Anonymous types cannot be
// named in .Produces<T>(), so every endpoint returning one described itself as `unknown` in
// the OpenAPI document and therefore in the generated TypeScript. Naming them is what turns
// { ok } and { valid } into types the SPA can consume instead of narrowing by hand.
public sealed record OkResponse(bool Ok);

public sealed record TokenValidityResponse(bool Valid);

public sealed record HealthResponse(string Database);

// api.md §Conventions: all timestamps UTC ISO-8601 in transport.
// Unspecified kinds are treated as UTC — never reinterpreted through server-local time.
public sealed class UtcDateTimeConverter : JsonConverter<DateTime>
{
    public override DateTime Read(ref Utf8JsonReader reader, Type typeToConvert, JsonSerializerOptions options)
        => AsUtc(reader.GetDateTime());

    public override void Write(Utf8JsonWriter writer, DateTime value, JsonSerializerOptions options)
        => writer.WriteStringValue(AsUtc(value));

    private static DateTime AsUtc(DateTime value) => value.Kind switch
    {
        DateTimeKind.Utc => value,
        DateTimeKind.Local => value.ToUniversalTime(),
        _ => DateTime.SpecifyKind(value, DateTimeKind.Utc),
    };
}

public sealed class UtcDateTimeOffsetConverter : JsonConverter<DateTimeOffset>
{
    public override DateTimeOffset Read(ref Utf8JsonReader reader, Type typeToConvert, JsonSerializerOptions options)
        => reader.GetDateTimeOffset().ToUniversalTime();

    public override void Write(Utf8JsonWriter writer, DateTimeOffset value, JsonSerializerOptions options)
        => writer.WriteStringValue(value.ToUniversalTime());
}

public static class ApiConventions
{
    public static IServiceCollection AddApiConventions(this IServiceCollection services)
    {
        services.ConfigureHttpJsonOptions(options =>
        {
            // api.md §Cross-cutting: unknown fields rejected, not ignored.
            options.SerializerOptions.UnmappedMemberHandling = JsonUnmappedMemberHandling.Disallow;
            options.SerializerOptions.Converters.Add(new UtcDateTimeConverter());
            options.SerializerOptions.Converters.Add(new UtcDateTimeOffsetConverter());
            // #145: lets a PATCH body tell an absent field from one explicitly sent as null.
            // See Patch.cs — the distinction is already in the JSON; this stops discarding it.
            options.SerializerOptions.Converters.Add(new PatchConverterFactory());
        });

        // Body-binding failures must surface as exceptions in every environment (not just
        // Development) so the handler below shapes them instead of an empty 400.
        services.Configure<RouteHandlerOptions>(options => options.ThrowOnBadRequest = true);

        return services;
    }

    public static WebApplication UseApiErrorHandling(this WebApplication app)
    {
        app.UseExceptionHandler(errorApp => errorApp.Run(async context =>
        {
            var exception = context.Features.Get<IExceptionHandlerFeature>()?.Error;

            var (status, error) = exception switch
            {
                BadHttpRequestException bad =>
                    (bad.StatusCode, ApiError.Create("bad_request", BadRequestMessage(bad))),
                _ =>
                    (StatusCodes.Status500InternalServerError,
                        ApiError.Create("internal_error", "An unexpected error occurred.")),
            };

            context.Response.StatusCode = status;
            await context.Response.WriteAsJsonAsync(error);
        }));

        // Gives bodyless 4xx/5xx responses (unmatched route, wrong method) the single error shape.
        app.UseStatusCodePages(async statusCodeContext =>
        {
            var response = statusCodeContext.HttpContext.Response;
            var code = response.StatusCode switch
            {
                StatusCodes.Status404NotFound => "not_found",
                StatusCodes.Status405MethodNotAllowed => "method_not_allowed",
                _ => "error",
            };
            await response.WriteAsJsonAsync(
                ApiError.Create(code, ReasonPhrases.GetReasonPhrase(response.StatusCode)));
        });

        return app;
    }

    private static string BadRequestMessage(BadHttpRequestException exception)
        => exception.InnerException is JsonException json
            ? $"{exception.Message} {json.Message}"
            : exception.Message;
}
