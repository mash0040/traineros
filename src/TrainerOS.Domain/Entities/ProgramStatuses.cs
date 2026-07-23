namespace TrainerOS.Domain.Entities;

// The three status values of programs.status (database.md §programs). Only "active"
// participates in the partial unique index that enforces at-most-one active per client.
public static class ProgramStatuses
{
    public const string Draft = "draft";
    public const string Active = "active";
    public const string Archived = "archived";

    public static bool IsValid(string value)
        => value is Draft or Active or Archived;
}
