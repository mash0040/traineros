using System.Security.Cryptography;
using System.Text;

using Microsoft.AspNetCore.WebUtilities;

namespace TrainerOS.Api.Auth;

// database.md §magic_link_tokens: store the SHA-256 hash, never the token — a DB leak
// must not yield working login links. The raw token exists only in the email. Shared
// with the verify endpoints (#21), which hash the presented token and compare.
public static class MagicLinkTokens
{
    public static readonly TimeSpan Lifetime = TimeSpan.FromMinutes(15);

    public static string NewRawToken()
        => WebEncoders.Base64UrlEncode(RandomNumberGenerator.GetBytes(32));

    public static string Hash(string rawToken)
        => Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(rawToken))).ToLowerInvariant();
}
