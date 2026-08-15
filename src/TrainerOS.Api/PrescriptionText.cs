using System.Text.RegularExpressions;

namespace TrainerOS.Api;

/// <summary>
/// A structural sanity check for the two free-text prescription fields — target_reps and
/// target_load. Deliberately not a parser.
/// </summary>
// #99 follow-up.
//
// ── What database.md settled, and what it did not ──────────────────────────────────────────
// §program_day_exercises: both fields are text "on purpose" — '8–10', 'AMRAP', 'RPE 7–8',
// '100 kg', '70%' — and "parsing for analytics is a v2 problem; v1 displays them verbatim."
// That contract is unchanged here. Nothing below understands units, reps or numbers, and
// nothing converts. The endpoint still stores whatever it is given, verbatim.
//
// What it did not settle is whether *anything* is refused. "70 lbsgjhm" and "AMRKJDNAK,M" both
// saved, and both reach a client as their prescription — a typo the trainer cannot see happen
// and the client cannot act on.
//
// ── Why this exists server-side and not only in the SPA ────────────────────────────────────
// The check shipped in the browser first. A guard that lives only there is a property of one
// browser rather than of the data: it is bypassed by a stale tab, a second client, or curl, and
// this API is what actually decides what a client is shown. So the rule is enforced where the
// write happens, and the SPA's copy stays for the immediate feedback it gives a trainer who is
// still typing.
//
// ── Where the line is drawn ────────────────────────────────────────────────────────────────
// Four structural rules. None reads the value for meaning; each rejects only what cannot be a
// phrase anyone writes in these fields.
//
//   1. Length ≤ 40. A prescription is short.
//   2. Character set. Letters, digits, whitespace, and the punctuation programming actually
//      uses. Emoji, currency, control characters are not reps.
//   3. An alphabetic run of four or more letters contains a vowel.
//   4. No run of six or more consecutive consonants anywhere.
//
// Rule 4 exists because rule 3 is not enough: "AMRKJDNAK" *has* vowels — three A's — so rule 3
// accepts it, and what marks it is the six-consonant run MRKJDN. Neither rule subsumes the
// other; a four-letter vowel-less run like "bcdf" trips 3 and not 4.
//
// Six, not five: English tops out at five consecutive consonants ("ngths" in "strengths" and
// "lengths"), so five would refuse real words. A false positive rejects a trainer's real
// prescription, which is worse than letting a typo through, so the threshold is set by the
// worst legitimate input rather than by the best catch rate.
//
// ── One rule, two languages ────────────────────────────────────────────────────────────────
// Mirrored in src/web/src/lib/prescriptionText.ts. There is no shared runtime between C# and
// TypeScript, so the implementation is duplicated. What stops the two drifting is not this
// comment but tests/shared/prescriptionText.cases.json — one corpus, read by
// PrescriptionTextTests here and by prescriptionText.test.ts there. Add a case to that file and
// both languages are held to it.
//
// It lives in the Api project rather than in Domain, alongside EmailAddresses, because it
// validates a request body rather than an entity invariant, and because the Api is the only
// host that writes prescriptions — the Functions read schedules and send email, and never touch
// this table. Domain is for what both hosts need.
public static partial class PrescriptionText
{
    private const int MaxLength = 40;

    /// <summary>Which field a message is about. The visible label, not the wire name.</summary>
    public enum Field
    {
        Reps,
        Load,
    }

    // The dash family is spelled out rather than ranged: an en dash appears in "8–10", and an em
    // dash is banned from rendered strings by DESIGN.md but not from a trainer's keyboard.
    [GeneratedRegex(@"^[\p{L}\p{N}\s%+\-–—/.,:×@()']*$")]
    private static partial Regex Allowed();

    /// <summary>Alphabetic runs of four or more, which are the only ones rule 3 examines.</summary>
    [GeneratedRegex(@"\p{L}{4,}")]
    private static partial Regex LongLetterRun();

    // y counts as a vowel in both rules. Without it "bodyweight" and "dryland" would be judged
    // on their consonants.
    [GeneratedRegex("[aeiouy]", RegexOptions.IgnoreCase)]
    private static partial Regex Vowel();

    /// <summary>Six or more consonants in a row; vowels, digits, spaces and punctuation break it.</summary>
    [GeneratedRegex("[b-df-hj-np-tv-xz]{6,}", RegexOptions.IgnoreCase)]
    private static partial Regex ConsonantRun();

    /// <summary>
    /// Null when the value is fine, or the sentence to show the trainer.
    /// </summary>
    // Worded identically to the SPA's copy, for the same reason the email rule is: whichever
    // layer catches it, this is one mistake to the trainer. If these strings change, those
    // change with them.
    //
    // An empty value is fine here. Load is optional, and Reps has its own required check at the
    // call site — a different question, with a better-worded answer already.
    public static string? Check(string? value, Field field)
    {
        var text = value?.Trim();
        if (string.IsNullOrEmpty(text))
        {
            return null;
        }

        var label = field == Field.Reps ? "Reps" : "Load";
        var lower = label.ToLowerInvariant();

        if (text.Length > MaxLength)
        {
            return $"Keep {lower} under {MaxLength} characters.";
        }

        if (!Allowed().IsMatch(text))
        {
            return $"{label} can use letters, numbers and the usual punctuation.";
        }

        foreach (Match run in LongLetterRun().Matches(text))
        {
            if (!Vowel().IsMatch(run.Value))
            {
                return Unpronounceable(lower, run.Value);
            }
        }

        var mashed = ConsonantRun().Match(text);
        if (mashed.Success)
        {
            return Unpronounceable(lower, mashed.Value);
        }

        return null;
    }

    // Names the run rather than the whole value, because the trainer's eye needs to land on the
    // part that is wrong — in "70 lbsgjhm" the number is fine and the word is not.
    private static string Unpronounceable(string lower, string run)
        => $"“{run}” doesn’t look like a word. Check the {lower}.";
}
