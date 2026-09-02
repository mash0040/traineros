using System.Text.Json;
using System.Text.Json.Serialization;

using Microsoft.OpenApi.Models;

using Swashbuckle.AspNetCore.SwaggerGen;

namespace TrainerOS.Api;

/// <summary>
/// A PATCH body field that knows whether it was sent (#145).
/// </summary>
///
/// <remarks>
/// The problem this exists for: <c>decimal?</c> on a request record collapses "not sent" and
/// "sent as null" into the same value, so a handler reading <c>is not null</c> can set a
/// nullable column but never clear one. A set logged at 60 kg could not be corrected to
/// bodyweight, an emptied rest interval silently reverted, and <c>starts_on</c> had no clear
/// path at all.
///
/// The distinction is already on the wire — <c>{"weightKg": null}</c> and <c>{}</c> are
/// different documents — so nothing has to be invented to carry it, only stopped from being
/// discarded. System.Text.Json invokes a converter only for properties actually present in the
/// document and fills missing record constructor parameters with <c>default</c>, so an absent
/// field arrives as <c>default(Patch&lt;T&gt;)</c> with <see cref="IsPresent"/> false. That is
/// the whole mechanism.
///
/// Three states, and every handler branches on all three:
/// <list type="bullet">
///   <item>absent — leave the column alone</item>
///   <item>present and null — clear the column, or 400 if the column is not nullable</item>
///   <item>present with a value — write it</item>
/// </list>
/// </remarks>
public readonly struct Patch<T>
{
    private Patch(bool isNull, T? value)
    {
        IsPresent = true;
        IsNull = isNull;
        Value = value;
    }

    /// <summary>Whether the field appeared in the request body at all.</summary>
    public bool IsPresent { get; }

    /// <summary>
    /// Whether the field was present and explicitly null, i.e. a request to clear the column.
    /// </summary>
    ///
    /// <remarks>
    /// Tracked as its own flag rather than derived from <see cref="Value"/>, and that is not
    /// defensive. <c>T</c> carries no <c>class</c> constraint, so for a value type <c>T?</c> is
    /// just <c>T</c> annotated and an explicit null deserializes to <c>default(T)</c> — which
    /// makes <c>{"restSeconds": null}</c> and <c>{"restSeconds": 0}</c> the same value, and
    /// <c>Value is null</c> permanently false.
    ///
    /// The first version of this type derived it, and the consequences were exactly the bug
    /// #145 exists to fix, wearing new clothes: clearing a weight would have written 0 kg
    /// instead of NULL, clearing a rest interval would have written 0 seconds, and a null on a
    /// NOT NULL column would have silently written a zero rather than being refused.
    /// </remarks>
    public bool IsNull { get; }

    /// <summary>
    /// The value sent. Meaningful only when <see cref="HasValue"/> is true — for a value-typed
    /// <c>T</c> this is <c>default(T)</c> rather than null when the field was cleared, which is
    /// why a nullable value-typed column reads <see cref="PatchExtensions.Nullable{T}"/> instead.
    /// </summary>
    public T? Value { get; }

    /// <summary>An actual value was sent. False for absent and false for explicit null.</summary>
    public bool HasValue(out T value)
    {
        value = Value!;
        return IsPresent && !IsNull;
    }

    internal static Patch<T> Cleared() => new(true, default);

    internal static Patch<T> Of(T? value) => new(false, value);
}

/// <summary>Reading a <see cref="Patch{T}"/> that targets a nullable value-typed column.</summary>
public static class PatchExtensions
{
    /// <summary>
    /// The sent value, or null when the caller cleared it.
    /// </summary>
    ///
    /// <remarks>
    /// Only value types need this. For a reference-typed <c>T</c> — every nullable text column
    /// on these routes — <see cref="Patch{T}.Value"/> is already null after a clear, so those
    /// call sites read it directly. The <c>struct</c> constraint is what makes <c>T?</c> mean
    /// <c>Nullable&lt;T&gt;</c> here rather than an annotation the runtime discards, which is the
    /// distinction that made the flag above necessary in the first place.
    /// </remarks>
    public static T? Nullable<T>(this Patch<T> field) where T : struct
        => field.IsNull ? null : field.Value;
}

/// <summary>
/// Reads <see cref="Patch{T}"/> from JSON. Never used for responses; request records only.
/// </summary>
///
/// <remarks>
/// <c>HandleNull</c> is the load-bearing override and not a detail. Left at its default of
/// false, System.Text.Json handles a null token itself rather than calling this converter, and
/// for a non-nullable struct that means throwing rather than producing the present-and-null
/// state this whole type exists to express.
/// </remarks>
public sealed class PatchConverter<T> : JsonConverter<Patch<T>>
{
    public override bool HandleNull => true;

    public override Patch<T> Read(ref Utf8JsonReader reader, Type typeToConvert, JsonSerializerOptions options)
    {
        // Reached only for a property that is present, so this is always the "sent" case. Null
        // included: the reader is sitting on a null token and JsonSerializer hands back default,
        // which for T? is null.
        if (reader.TokenType == JsonTokenType.Null)
        {
            return Patch<T>.Cleared();
        }

        return Patch<T>.Of(JsonSerializer.Deserialize<T>(ref reader, options));
    }

    public override void Write(Utf8JsonWriter writer, Patch<T> value, JsonSerializerOptions options)
    {
        // Only reachable if something serializes a request record, which nothing does. Absent
        // has no representation inside an already-started object, so it writes as null; the
        // alternative would be for this method to control whether the property exists, which is
        // not a decision a value converter is given.
        if (value.IsNull || value.Value is null)
        {
            writer.WriteNullValue();
            return;
        }

        JsonSerializer.Serialize(writer, value.Value, options);
    }
}

/// <summary>Shared handling for <see cref="Patch{T}"/> fields across the PATCH endpoints.</summary>
public static class PatchRequests
{
    /// <summary>
    /// Refuses an explicit null for a field backed by a NOT NULL column.
    /// </summary>
    ///
    /// <remarks>
    /// Under #145 null means "clear this", so on a column that cannot be cleared it is a request
    /// to do something impossible. Before #145 the same body was silently treated as "leave
    /// alone" — the caller got a 200 and no field changed, which is the failure mode this whole
    /// issue is about, only pointing the other way.
    ///
    /// Returns null when the field is fine, so call sites read as
    /// <c>if (PatchRequests.RejectNull(body.X, "x") is { } error) return error;</c>. The name is
    /// the wire name, because that is what the caller sent and what the message has to name.
    /// </remarks>
    public static IResult? RejectNull<T>(Patch<T> field, string wireName)
        => field.IsNull
            ? Results.BadRequest(ApiError.Create("bad_request", $"{wireName} cannot be null."))
            : null;
}

/// <summary>Hands System.Text.Json a <see cref="PatchConverter{T}"/> for any closed Patch&lt;T&gt;.</summary>
public sealed class PatchConverterFactory : JsonConverterFactory
{
    public override bool CanConvert(Type typeToConvert)
        => typeToConvert.IsGenericType && typeToConvert.GetGenericTypeDefinition() == typeof(Patch<>);

    public override JsonConverter CreateConverter(Type typeToConvert, JsonSerializerOptions options)
        => (JsonConverter)Activator.CreateInstance(
            typeof(PatchConverter<>).MakeGenericType(typeToConvert.GetGenericArguments()[0]))!;
}

/// <summary>
/// Makes <see cref="Patch{T}"/> invisible to the OpenAPI document, and therefore to the SPA.
/// </summary>
///
/// <remarks>
/// Without this, Swashbuckle describes <c>Patch&lt;string&gt;</c> structurally — an object with
/// <c>isPresent</c> and <c>value</c> — and the generated TypeScript turns every PATCH body field
/// into a nested object the SPA cannot build. The wrapper is a server-side mechanism for reading
/// what the wire already says; it must not appear on the wire.
///
/// So each closed Patch&lt;T&gt; is mapped to exactly the schema its bare <c>T?</c> produced
/// before, which is what keeps <c>types.gen.ts</c> byte-identical across this change.
/// </remarks>
public static class PatchSchemas
{
    public static void MapPatchTypes(this SwaggerGenOptions options)
    {
        options.MapType<Patch<string>>(() => Nullable("string"));
        options.MapType<Patch<bool>>(() => Nullable("boolean"));
        options.MapType<Patch<int>>(() => Nullable("integer", "int32"));
        options.MapType<Patch<decimal>>(() => Nullable("number", "double"));
        options.MapType<Patch<Guid>>(() => Nullable("string", "uuid"));
        options.MapType<Patch<DateOnly>>(() => Nullable("string", "date"));
        options.MapType<Patch<TimeOnly>>(() => Nullable("string", "time"));
        options.MapType<Patch<int[]>>(() => new OpenApiSchema
        {
            Type = "array",
            Nullable = true,
            Items = new OpenApiSchema { Type = "integer", Format = "int32" },
        });
    }

    private static OpenApiSchema Nullable(string type, string? format = null)
        => new() { Type = type, Format = format, Nullable = true };
}

/// <summary>
/// Keeps Patch&lt;T&gt; fields optional and nullable in the OpenAPI document.
/// </summary>
///
/// <remarks>
/// The second half of the same problem, and both halves come from one fact: <c>Patch&lt;T&gt;</c>
/// is a non-nullable struct, so Swashbuckle reads the member as neither optional nor nullable
/// even though the JSON it stands for is both.
///
/// <para><b>Nullable.</b> <see cref="PatchSchemas"/> maps each closed Patch to a nullable schema,
/// but Swashbuckle re-derives <c>nullable</c> per property from the member's own annotation and
/// overwrites it. Left alone, the probe produced <c>name?: string</c> where the committed types
/// have <c>name?: string | null</c> — which would take away the ability to send an explicit null,
/// the one capability this whole change exists to add.</para>
///
/// <para><b>Required.</b> A non-nullable member is a candidate for the schema's <c>required</c>
/// array, which would turn <c>videoUrl?:</c> into <c>videoUrl:</c> and force every caller to send
/// every field, the exact opposite of what a PATCH body is. Absent is a meaningful state here, so
/// no Patch field is ever required.</para>
/// </remarks>
public sealed class PatchOptionalSchemaFilter : ISchemaFilter
{
    public void Apply(OpenApiSchema schema, SchemaFilterContext context)
    {
        var patched = context.Type
            .GetProperties()
            .Where(p => p.PropertyType.IsGenericType
                && p.PropertyType.GetGenericTypeDefinition() == typeof(Patch<>))
            .Select(p => p.Name)
            .ToList();

        if (patched.Count == 0)
        {
            return;
        }

        // Swashbuckle's property and required entries carry the serialized (camelCase) name;
        // match case-insensitively rather than reimplementing the naming policy here.
        bool IsPatch(string wireName)
            => patched.Any(name => string.Equals(wireName, name, StringComparison.OrdinalIgnoreCase));

        foreach (var property in schema.Properties.Where(p => IsPatch(p.Key)))
        {
            property.Value.Nullable = true;
        }

        if (schema.Required is not { Count: > 0 })
        {
            return;
        }

        foreach (var name in schema.Required.Where(IsPatch).ToList())
        {
            schema.Required.Remove(name);
        }
    }
}
