using System.Net.Mail;

namespace TrainerOS.Api;

/// <summary>
/// Whether a string is an address this system can actually deliver to.
/// </summary>
// #114: POST /api/clients was already calling MailAddress.TryCreate and a malformed address
// still created a row. The call was not missing — it was answering a different question.
//
// ── What MailAddress.TryCreate actually parses ─────────────────────────────────────────────
// RFC 5322 *mailbox* syntax, which is "display name plus angle-bracketed address", not a bare
// address. So all of these come back true:
//
//     "Ada <ada@example.com>"           -> Address='ada@example.com'  DisplayName='Ada'
//     "ada example@example.com"         -> Address='example@example.com'  DisplayName='ada'
//     "<ada@example.com>"               -> Address='ada@example.com'
//     "ada@example.com, bob@example.com"-> Address='bob@example.com'  DisplayName='ada@example.com,'
//
// The endpoint then stored the *raw* input rather than the parsed address, so users.Email
// became "ada example@example.com". Nothing downstream can use that: UserByEmail never matches
// it, so magic links silently do nothing, and the reminder worker hands it to the sender as a
// recipient. Meanwhile the roster renders it and the row looks fine — which is exactly the
// failure #114 describes.
//
// The fix for that whole family is one line: require the parse to round-trip. If the address
// the parser found is not byte-for-byte what was typed, or it also found a display name, the
// input was mailbox syntax and not an address.
//
// ── The second, milder family ──────────────────────────────────────────────────────────────
// TryCreate also accepts domains nothing can route to: ada@localhost, ada@b, ada@example..com,
// ada@example.com., ada@-example.com. These are not parser confusion, they are just not
// deliverable over public SMTP, which is the only kind of mail this system sends. Hence the
// domain checks below.
//
// Deliberately not an RFC-complete grammar. That is a famous rabbit hole and the wrong goal:
// the question here is not "could this exist somewhere" but "will a magic link arrive", and
// the only real proof of that is the send itself. This rejects what is certainly undeliverable
// and lets everything else through to be proven by use.
public static class EmailAddresses
{
    public static bool IsValid(string? candidate)
    {
        if (string.IsNullOrWhiteSpace(candidate))
        {
            return false;
        }

        if (!MailAddress.TryCreate(candidate, out var parsed) || parsed is null)
        {
            return false;
        }

        // The round trip. Kills display names, angle brackets, embedded spaces, and comma
        // lists in one check, because in every one of those the parsed address differs from
        // what was typed.
        if (!string.Equals(parsed.Address, candidate, StringComparison.Ordinal)
            || parsed.DisplayName.Length != 0)
        {
            return false;
        }

        var at = candidate.LastIndexOf('@');
        if (at <= 0 || at == candidate.Length - 1)
        {
            return false;
        }

        var local = candidate[..at];
        var domain = candidate[(at + 1)..];

        // MailAddress rejects a leading dot in the local part but accepts a doubled one.
        if (local.Contains("..", StringComparison.Ordinal))
        {
            return false;
        }

        // At least two labels, so single-label domains (ada@localhost, ada@b) are out. Labels
        // are letters, digits, and hyphens, and a hyphen may not start or end one — which also
        // takes care of empty labels from a doubled or trailing dot, and of bracketed IP
        // literals like ada@[127.0.0.1].
        //
        // char.IsLetterOrDigit is Unicode-aware rather than ASCII-only on purpose: an
        // internationalized domain is a real address, and rejecting a deliverable one is a
        // worse failure than accepting an odd one.
        var labels = domain.Split('.');
        if (labels.Length < 2)
        {
            return false;
        }

        foreach (var label in labels)
        {
            if (label.Length == 0 || label[0] == '-' || label[^1] == '-')
            {
                return false;
            }

            foreach (var character in label)
            {
                if (!char.IsLetterOrDigit(character) && character != '-')
                {
                    return false;
                }
            }
        }

        return true;
    }
}
