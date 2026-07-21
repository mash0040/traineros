namespace TrainerOS.Api.Auth;

// api.md §Auth: opaque session id in an httpOnly, Secure, SameSite=Lax cookie.
public static class SessionCookie
{
    public const string Name = "traineros_session";

    public static void Append(HttpResponse response, Guid sessionId, DateTimeOffset expiresAt)
        => response.Cookies.Append(Name, sessionId.ToString(), new CookieOptions
        {
            HttpOnly = true,
            Secure = true,
            SameSite = SameSiteMode.Lax,
            Path = "/",
            Expires = expiresAt,
        });
}
