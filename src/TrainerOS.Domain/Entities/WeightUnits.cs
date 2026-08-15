namespace TrainerOS.Domain.Entities;

// The two values of users.weight_unit (database.md §users, #99).
//
// Storage stays canonical: logged_sets.weight_kg is always kilograms, and this column decides
// only what a person is shown and what their typing means. One unit in the database means a
// set never carries an ambiguous number, and /api/me/last can compare two sets logged months
// apart without asking what either of them meant.
//
// Default is Lb, per #99: most Canadian gyms load pound plates, and a client converting every
// set in their head loses to the paper notebook on the axis ui-ux.md says the app must win.
public static class WeightUnits
{
    public const string Kg = "kg";
    public const string Lb = "lb";

    /// <summary>What a user gets when nobody has said otherwise.</summary>
    public const string Default = Lb;

    public static bool IsValid(string value)
        => value is Kg or Lb;

    /// <summary>
    /// Trim-and-lowercase before validating, which is a small departure from how `timezone`
    /// is matched exactly. It is worth it for a two-value enum: "LB" from a hand-written
    /// request is unambiguous, and answering it with a 400 would be pedantry rather than
    /// safety. Returns null when the value is not one of the two.
    /// </summary>
    public static string? Normalize(string? value)
    {
        var candidate = value?.Trim().ToLowerInvariant();
        return candidate is not null && IsValid(candidate) ? candidate : null;
    }
}
