namespace TrainerOS.Api;

// One App Service serves both the API and the built SPA (architecture.md §Deployment shape):
// the deploy pipeline copies Vite's output into wwwroot, which is what makes the client
// same-origin with the API — the session cookie is first-party and there is no CORS surface
// to configure at all (api.md's preferred case).
//
// Nothing here runs in local dev: Vite serves the client on 5173 and proxies /api, so
// wwwroot is empty and every request falls through to the JSON 404. That is the same code
// path production takes when a deploy forgets the SPA, which is worth knowing.
public static class SpaHosting
{
    public static WebApplication UseSpaHosting(this WebApplication app)
    {
        // Vite content-hashes everything under /assets, so those are immutable; index.html
        // must not be, or a browser holding a cached shell keeps loading the previous
        // deploy's bundle names long after they stopped existing.
        var staticFiles = new StaticFileOptions
        {
            OnPrepareResponse = context =>
                context.Context.Response.Headers.CacheControl =
                    context.Context.Request.Path.StartsWithSegments("/assets")
                        ? "public, max-age=31536000, immutable"
                        : "no-cache",
        };

        app.Use(async (context, next) =>
        {
            var noIndex = ShouldNoIndex(context.Request.Path);
            if (noIndex)
            {
                context.Response.OnStarting(() =>
                {
                    if (context.Response.StatusCode is >= 200 and < 400)
                    {
                        context.Response.Headers["X-Robots-Tag"] = "noindex, nofollow";
                    }

                    return Task.CompletedTask;
                });
            }

            await next();
        });
        app.UseStaticFiles(staticFiles);

        // /verify?token= and /pause?token= are pasted into a browser's address bar from an
        // email, so a deep link has to return the shell and let BrowserRouter take it from
        // there. The `nonfile` constraint on the fallback route is what keeps real assets
        // reaching the static-file middleware.
        //
        // /api is deliberately excluded: an API call that gets index.html back does not fail
        // as a 404, it fails as a JSON parse error three layers away from its cause. Routing
        // prefers the literal /api prefix over the catch-all, so unmatched API routes keep
        // the single error envelope (api.md §Cross-cutting) via UseStatusCodePages.
        app.MapFallback("/api/{**rest}", () => Results.NotFound());
        app.MapFallbackToFile("index.html", staticFiles);

        return app;
    }

    private static bool ShouldNoIndex(PathString path)
    {
        foreach (var prefix in NoIndexAppPathPrefixes)
        {
            if (path.StartsWithSegments(prefix))
            {
                return true;
            }
        }

        return false;
    }

    private static readonly PathString[] NoIndexAppPathPrefixes =
    {
        "/login",
        "/verify",
        "/pause",
        "/workout",
        "/history",
        "/clients",
        "/exercises",
        "/programs",
    };
}
