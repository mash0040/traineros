using System.Text.Json;

using TrainerOS.Api;

namespace TrainerOS.Tests;

// The structural sanity check for target_reps and target_load (#99 follow-up).
//
// The corpus half of this file is the point. The rule is implemented twice — here in C# and in
// src/web/src/lib/prescriptionText.ts — because there is no shared runtime between the API and
// the SPA. A comment in each pointing at the other is not a guarantee that they agree;
// src/web/src/lib/prescriptionText.cases.json is, because both suites read it and assert every
// case. A rule that drifts in one language fails a test in the other.
//
// That the corpus sits under src/web is a constraint of the SPA's toolchain rather than a claim
// of ownership — its own header records why. This side does not care where it is; it walks up
// from the test binary until it finds it.
public class PrescriptionTextTests
{
    public sealed record Corpus(List<string> Accept, List<string> Reject);

    /// <summary>
    /// The shared corpus, found by walking up from the test binary to the repository root.
    ///
    /// Walked rather than copied to the output directory: a copy is a second file that can be
    /// stale, which is the exact failure this corpus exists to prevent.
    /// </summary>
    private static Corpus Load()
    {
        var directory = new DirectoryInfo(AppContext.BaseDirectory);
        while (directory is not null)
        {
            var candidate = Path.Combine(
                directory.FullName, "src", "web", "src", "lib", "prescriptionText.cases.json");
            if (File.Exists(candidate))
            {
                var json = File.ReadAllText(candidate);
                return JsonSerializer.Deserialize<Corpus>(json, new JsonSerializerOptions
                {
                    PropertyNameCaseInsensitive = true,
                })!;
            }
            directory = directory.Parent;
        }

        throw new FileNotFoundException(
            "src/web/src/lib/prescriptionText.cases.json not found walking up from "
            + AppContext.BaseDirectory);
    }

    public static TheoryData<string> Accepted()
    {
        var data = new TheoryData<string>();
        foreach (var value in Load().Accept)
        {
            data.Add(value);
        }
        return data;
    }

    public static TheoryData<string> Rejected()
    {
        var data = new TheoryData<string>();
        foreach (var value in Load().Reject)
        {
            data.Add(value);
        }
        return data;
    }

    // Both fields run the same rules, so the corpus is asserted against both. If they ever need
    // to differ — a tighter ceiling on reps was considered and rejected — this is where that
    // shows up as a decision rather than as a surprise.
    [Theory]
    [MemberData(nameof(Accepted))]
    public void Accepts_every_shape_of_real_coaching_language(string value)
    {
        Assert.Null(PrescriptionText.Check(value, PrescriptionText.Field.Reps));
        Assert.Null(PrescriptionText.Check(value, PrescriptionText.Field.Load));
    }

    [Theory]
    [MemberData(nameof(Rejected))]
    public void Refuses_what_cannot_be_a_phrase(string value)
    {
        Assert.NotNull(PrescriptionText.Check(value, PrescriptionText.Field.Reps));
        Assert.NotNull(PrescriptionText.Check(value, PrescriptionText.Field.Load));
    }

    [Fact]
    public void The_corpus_is_actually_being_read()
    {
        // Otherwise an empty or mis-parsed corpus would make every theory above vacuously pass,
        // which is the one way a shared fixture can fail silently.
        var corpus = Load();
        Assert.True(corpus.Accept.Count > 20);
        Assert.True(corpus.Reject.Count > 5);
    }

    [Fact]
    public void Names_the_field_the_trainer_is_looking_at()
    {
        // The visible label, not the wire name: whichever layer catches it, this is one mistake
        // to the trainer, so the sentence matches the SPA's.
        Assert.Contains("reps", PrescriptionText.Check("70 lbsgjhm", PrescriptionText.Field.Reps));
        Assert.Contains("load", PrescriptionText.Check("70 lbsgjhm", PrescriptionText.Field.Load));
    }

    [Fact]
    public void Names_the_run_rather_than_the_whole_value()
    {
        // In "70 lbsgjhm" the number is fine and the word is not, so the trainer's eye needs to
        // land on the part that is wrong.
        Assert.Contains("lbsgjhm", PrescriptionText.Check("70 lbsgjhm", PrescriptionText.Field.Load));
        Assert.Contains("MRKJDN", PrescriptionText.Check("AMRKJDNAK,M", PrescriptionText.Field.Load));
    }

    [Fact]
    public void Treats_an_absent_value_as_nothing_to_check()
    {
        // Load is optional and a blank one clears it to NULL. Reps is required, but by its own
        // check at the call site — a different question with a better-worded answer.
        Assert.Null(PrescriptionText.Check(null, PrescriptionText.Field.Load));
        Assert.Null(PrescriptionText.Check("   ", PrescriptionText.Field.Load));
    }

    [Fact]
    public void Understands_nothing_about_the_value_it_accepts()
    {
        // Not a parser: it cannot tell a unit from a word, a plausible weight from an absurd
        // one, and it never converts. database.md's free-text decision is intact.
        Assert.Null(PrescriptionText.Check("70 furlongs", PrescriptionText.Field.Load));
        Assert.Null(PrescriptionText.Check("99999 kg", PrescriptionText.Field.Load));
        Assert.Null(PrescriptionText.Check("-5 kg", PrescriptionText.Field.Load));
    }

    [Fact]
    public void Lets_pronounceable_nonsense_through_on_purpose()
    {
        // "asdfgh" has a vowel and a five-consonant run, so it passes. Catching it needs n-grams
        // or a dictionary — a parser by another name — and a dictionary that does not know
        // "backoffs" would start refusing real coaching language.
        Assert.Null(PrescriptionText.Check("asdfgh", PrescriptionText.Field.Reps));
    }
}
