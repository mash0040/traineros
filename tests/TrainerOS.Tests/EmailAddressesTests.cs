using TrainerOS.Api;

namespace TrainerOS.Tests;

// #114. These are written to survive mutation, which for a validator means the rejections
// carry the weight: a test suite that only proves valid addresses are accepted is passed by
// `IsValid => true`, and that is effectively what the old suite was — it asserted one malformed
// input ("not-an-email"), which is one of the few MailAddress.TryCreate already refused. The
// bug lived in the gap between "the check runs" and "the check rejects what it must".
//
// Every string in the rejected list below was verified to be ACCEPTED by a bare
// MailAddress.TryCreate. They are the regression suite, not a hypothetical grammar.
public class EmailAddressesTests
{
    [Theory]
    [InlineData("ada@example.com")]
    [InlineData("ada.lovelace@example.com")]
    [InlineData("ada+tag@example.co.uk")]
    [InlineData("ada-1@sub.example.com")]
    [InlineData("ADA@EXAMPLE.COM")]
    // Unicode domains are real addresses. The label check is deliberately Unicode-aware, and
    // this pins that: rejecting a deliverable address is a worse failure than accepting an odd
    // one, because it locks a real client out of the product with no way around it.
    [InlineData("ada@münchen.de")]
    public void Accepts_deliverable_addresses(string candidate)
    {
        Assert.True(EmailAddresses.IsValid(candidate));
    }

    // The family that caused #114. MailAddress.TryCreate parses RFC 5322 mailbox syntax, so
    // each of these "succeeds" while parsing to an address that is not what was typed — and
    // the endpoint stored what was typed. The round-trip check is the only thing rejecting
    // them, so if it is ever removed, every one of these fails.
    [Theory]
    [InlineData("Ada <ada@example.com>")]
    [InlineData("\"Ada\" <ada@example.com>")]
    [InlineData("<ada@example.com>")]
    [InlineData("ada example@example.com")]
    [InlineData("ada@example.com, bob@example.com")]
    public void Rejects_mailbox_syntax_that_is_not_a_bare_address(string candidate)
    {
        Assert.False(EmailAddresses.IsValid(candidate));
    }

    // The milder family: parses cleanly, routes nowhere. Public SMTP is the only kind of mail
    // this system sends, so a single-label or malformed domain is undeliverable by definition.
    [Theory]
    [InlineData("ada@localhost")]
    [InlineData("ada@b")]
    [InlineData("ada@example..com")]
    [InlineData("ada@example.com.")]
    [InlineData("ada@-example.com")]
    [InlineData("ada@example-.com")]
    [InlineData("ada@exam_ple.com")]
    [InlineData("ada..b@example.com")]
    [InlineData("ada@[127.0.0.1]")]
    public void Rejects_undeliverable_domains(string candidate)
    {
        Assert.False(EmailAddresses.IsValid(candidate));
    }

    // Already rejected before #114, kept so a rewrite of the rule cannot quietly lose them.
    [Theory]
    [InlineData(null)]
    [InlineData("")]
    [InlineData("   ")]
    [InlineData("plainaddress")]
    [InlineData("ada@")]
    [InlineData("@example.com")]
    [InlineData("ada@@example.com")]
    [InlineData(".ada@example.com")]
    [InlineData("ada@exa mple.com")]
    public void Rejects_what_was_already_rejected(string? candidate)
    {
        Assert.False(EmailAddresses.IsValid(candidate));
    }

    [Fact]
    public void Rejects_an_address_whose_display_name_hides_a_different_recipient()
    {
        // The sharp edge stated as a property rather than a case. Anything that parses to an
        // address other than itself is a string where the human sees one recipient and the
        // mail system sees another, which is the whole problem.
        const string candidate = "ada@example.com <bob@example.com>";
        var parsed = new System.Net.Mail.MailAddress(candidate);

        Assert.Equal("bob@example.com", parsed.Address);
        Assert.False(EmailAddresses.IsValid(candidate));
    }
}
