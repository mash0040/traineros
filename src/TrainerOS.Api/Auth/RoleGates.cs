using TrainerOS.Domain.Entities;

namespace TrainerOS.Api.Auth;

// api.md §Authorization pt 4: role gates are route-level convenience, ownership stays
// query-level. Two distinct rejections:
//   - no valid session (absent/expired/revoked cookie) → 401: the SPA needs "session
//     gone, go to login" as a distinct signal, and 401 to an anonymous caller leaks
//     nothing about what exists.
//   - authenticated but wrong role → 404, never 403: same non-leak rule as scoped
//     queries — a client probing trainer routes learns nothing.
public static class RoleGates
{
    public static TBuilder RequireTrainer<TBuilder>(this TBuilder builder) where TBuilder : IEndpointConventionBuilder
        => builder.AddEndpointFilter(new RequireRoleFilter(Roles.Trainer));

    public static TBuilder RequireClient<TBuilder>(this TBuilder builder) where TBuilder : IEndpointConventionBuilder
        => builder.AddEndpointFilter(new RequireRoleFilter(Roles.Client));

    private sealed class RequireRoleFilter(string role) : IEndpointFilter
    {
        public async ValueTask<object?> InvokeAsync(EndpointFilterInvocationContext context, EndpointFilterDelegate next)
        {
            var user = context.HttpContext.GetCurrentUser();
            if (user is null)
            {
                return Results.Json(
                    ApiError.Create("unauthorized", "Authentication required."),
                    statusCode: StatusCodes.Status401Unauthorized);
            }

            if (user.Role != role)
            {
                return Results.NotFound(ApiError.Create("not_found", "Not Found"));
            }

            return await next(context);
        }
    }
}
