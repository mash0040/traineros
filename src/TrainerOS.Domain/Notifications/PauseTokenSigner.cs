using System.Security.Cryptography;
using System.Text;

namespace TrainerOS.Domain.Notifications;

// notifications.md resolved question 2: the pause link carries a signed, single-purpose
// token (HMAC of schedule_id + expiry). Signed rather than stored because the reminder
// pipeline has no session to hang authorization on — possession of the emailed link *is*
// the authorization, and a stateless token needs no row, no cleanup, and no write on the
// GET that a mail scanner will inevitably make.
//
// Lives in Domain because both hosts need it: the worker (Functions) issues one per
// reminder, the API validates it. Same seam as ReminderMessage.
public sealed class PauseTokenSigner
{
    // Long enough that a reminder sitting a few weeks in an inbox still pauses when the
    // client finally gets annoyed, short enough that a leaked mailbox is not a permanent
    // pause button. Every reminder carries a fresh token, so the newest email always works.
    public static readonly TimeSpan Lifetime = TimeSpan.FromDays(30);

    // Domain separation: mixed into the MAC so this key can never be made to validate a
    // signature minted for some other purpose if one is added later.
    private const string Purpose = "pause";

    private const int MinimumKeyLength = 32;

    private readonly byte[] _key;

    public PauseTokenSigner(string signingKey)
    {
        if (string.IsNullOrWhiteSpace(signingKey) || signingKey.Length < MinimumKeyLength)
        {
            throw new ArgumentException(
                $"The pause-token signing key must be at least {MinimumKeyLength} characters. "
                + "A weak key here means anyone can mint a link that pauses any client's reminders.",
                nameof(signingKey));
        }

        _key = Encoding.UTF8.GetBytes(signingKey);
    }

    /// <summary>Mints the token for one schedule's pause link.</summary>
    // Three segments on the wire — id.expiry.signature. The purpose label is signed but not
    // transmitted: it is a constant, so sending it would only pad the URL.
    public string Issue(Guid scheduleId, DateTimeOffset now)
    {
        var expiresAt = (now + Lifetime).ToUnixTimeSeconds();
        return $"{scheduleId:N}.{expiresAt}.{Sign(Payload(scheduleId, expiresAt))}";
    }

    /// <summary>
    /// Returns the schedule the token authorizes pausing, or null if it is malformed,
    /// tampered with, or expired.
    /// </summary>
    // One null for every failure: callers have no way to build an oracle out of the
    // difference between "bad signature" and "expired", and neither distinction helps the
    // person holding the link.
    public Guid? Validate(string? token, DateTimeOffset now)
    {
        if (string.IsNullOrWhiteSpace(token))
        {
            return null;
        }

        var parts = token.Split('.');
        if (parts.Length != 3
            || !Guid.TryParseExact(parts[0], "N", out var scheduleId)
            || !long.TryParse(parts[1], out var expiresAt))
        {
            return null;
        }

        var expected = Sign(Payload(scheduleId, expiresAt));
        if (!CryptographicOperations.FixedTimeEquals(
                Encoding.UTF8.GetBytes(expected), Encoding.UTF8.GetBytes(parts[2])))
        {
            return null;
        }

        return DateTimeOffset.FromUnixTimeSeconds(expiresAt) > now ? scheduleId : null;
    }

    // The expiry is inside the MAC, not merely alongside it — otherwise anyone could edit
    // the timestamp and keep a token alive forever.
    private static string Payload(Guid scheduleId, long expiresAt)
        => $"{Purpose}.{scheduleId:N}.{expiresAt}";

    private string Sign(string payload)
        => Base64Url(HMACSHA256.HashData(_key, Encoding.UTF8.GetBytes(payload)));

    // Hand-rolled base64url keeps the token URL-safe without dragging an ASP.NET
    // dependency into Domain for one call.
    private static string Base64Url(byte[] value)
        => Convert.ToBase64String(value).TrimEnd('=').Replace('+', '-').Replace('/', '_');
}
