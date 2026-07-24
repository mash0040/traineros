namespace TrainerOS.Api.Notifications;

// Bound from the "Resend" config section. Both fields are validated at startup
// via .Validate() in AddResendNotificationSender — a Production start without
// Resend:ApiKey or Resend:From fails fast, so silent misconfiguration cannot
// leave reminders unwired (matches the Program.cs guard's intent).
public sealed class ResendOptions
{
    public string ApiKey { get; set; } = string.Empty;
    public string From { get; set; } = string.Empty;
}
