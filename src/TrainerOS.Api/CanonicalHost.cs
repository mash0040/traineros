using Microsoft.AspNetCore.Http.Extensions;

namespace TrainerOS.Api;

// `www.traineros.me` and `traineros.me` both resolve to the web app's inbound IP and both
// serve this site, which is two origins for one product. The session cookie carries no
// Domain (Auth/SessionCookie.cs), so it is host-only: signing in at `www.` leaves you
// signed out at the apex, and every magic link and reminder footer is built from
// `App:BaseUrl` — a single host. The apex is the canonical one; this is what enforces that
// rather than merely asserting it (#158).
//
// The rule is a `www.` prefix, not an allow-list of known hosts. Stripping the prefix
// derives the target, so there is no second place to update when a domain changes, and
// every other host falls through untouched — `localhost` in dev and
// `app-traineros.azurewebsites.net` (the deploy pipeline's smoke-check host, which must
// keep answering 200 with the SPA shell) are excluded by construction rather than by a
// list someone has to remember to maintain.
public static class CanonicalHost
{
    private const string WwwPrefix = "www.";

    public static WebApplication UseCanonicalHost(this WebApplication app)
    {
        app.Use(async (context, next) =>
        {
            var request = context.Request;
            var host = request.Host;

            if (!host.Host.StartsWith(WwwPrefix, StringComparison.OrdinalIgnoreCase))
            {
                await next();
                return;
            }

            var apexHost = host.Host[WwwPrefix.Length..];
            var apex = host.Port is { } port
                ? new HostString(apexHost, port)
                : new HostString(apexHost);

            context.Response.Redirect(
                UriHelper.BuildAbsolute(
                    CanonicalScheme(request),
                    apex,
                    request.PathBase,
                    request.Path,
                    request.QueryString),
                permanent: true);
        });

        return app;
    }

    // Azure App Service terminates TLS at the front end and forwards to Kestrel over plain
    // HTTP, and nothing in this app calls UseForwardedHeaders — so Request.Scheme reads
    // "http" in production. Echoing it would answer an HTTPS request with a Location that
    // drops the visitor onto http://, on a site that is HTTPS-only. Hardcoding https is
    // what UseForwardedHeaders would otherwise supply from X-Forwarded-Proto.
    //
    // Loopback keeps its own scheme, so the mechanism stays exercisable without TLS. Only
    // reached for a `www.`-prefixed host, which is why `www.localhost` is the case to match.
    private static string CanonicalScheme(HttpRequest request)
        => request.Host.Host.Equals("www.localhost", StringComparison.OrdinalIgnoreCase)
            ? request.Scheme
            : Uri.UriSchemeHttps;
}
