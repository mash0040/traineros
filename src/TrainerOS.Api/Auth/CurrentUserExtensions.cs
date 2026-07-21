using TrainerOS.Domain.Entities;

namespace TrainerOS.Api.Auth;

// Identity comes only from the session cookie (api.md §Conventions): the middleware is
// the sole writer of this slot, so a handler reading it can never be fed an id from a
// request body or query string.
public static class CurrentUserExtensions
{
    private static readonly object Key = new();

    internal static void SetCurrentUser(this HttpContext context, User user)
        => context.Items[Key] = user;

    public static User? GetCurrentUser(this HttpContext context)
        => context.Items.TryGetValue(Key, out var user) ? (User?)user : null;
}
