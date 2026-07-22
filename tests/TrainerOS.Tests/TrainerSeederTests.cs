using Microsoft.Data.Sqlite;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.DependencyInjection;

using TrainerOS.Api.Auth;
using TrainerOS.Domain.Data;
using TrainerOS.Domain.Entities;

namespace TrainerOS.Tests;

public sealed class TrainerSeederTests : IDisposable
{
    private readonly SqliteConnection _connection;
    private readonly ServiceProvider _provider;

    public TrainerSeederTests()
    {
        _connection = new SqliteConnection("DataSource=:memory:");
        _connection.Open();

        var services = new ServiceCollection();
        services.AddLogging();
        services.AddSingleton<TimeProvider>(new FakeClock());
        services.AddDbContext<TrainerOsDbContext>(o => o.UseSqlite(_connection));
        _provider = services.BuildServiceProvider();

        WithDb(db => db.Database.EnsureCreated());
    }

    public void Dispose()
    {
        _provider.Dispose();
        _connection.Dispose();
    }

    private T WithDb<T>(Func<TrainerOsDbContext, T> action)
    {
        using var scope = _provider.CreateScope();
        return action(scope.ServiceProvider.GetRequiredService<TrainerOsDbContext>());
    }

    private static IConfiguration Config(params (string Key, string Value)[] pairs)
        => new ConfigurationBuilder()
            .AddInMemoryCollection(pairs.ToDictionary(p => p.Key, p => (string?)p.Value))
            .Build();

    [Fact]
    public async Task Seeds_trainer_with_argon2id_hash_that_verifies()
    {
        await TrainerSeeder.SeedAsync(_provider,
            Config(("Seed:TrainerEmail", "coach@example.com"), ("Seed:TrainerPassword", "correct horse battery")));

        var trainer = WithDb(db => db.UserByEmail("coach@example.com").Single());
        Assert.Equal(Roles.Trainer, trainer.Role);
        Assert.True(trainer.IsActive);
        Assert.StartsWith("$argon2id$", trainer.PasswordHash);
        Assert.True(Passwords.Verify("correct horse battery", trainer.PasswordHash!));
        Assert.False(Passwords.Verify("wrong password", trainer.PasswordHash!));
    }

    [Fact]
    public async Task Rerun_neither_duplicates_nor_overwrites()
    {
        await TrainerSeeder.SeedAsync(_provider,
            Config(("Seed:TrainerEmail", "coach@example.com"), ("Seed:TrainerPassword", "first-password")));
        var originalHash = WithDb(db => db.UserByEmail("coach@example.com").Single().PasswordHash);

        // Same env re-applied, and a hostile variant: different email + password.
        await TrainerSeeder.SeedAsync(_provider,
            Config(("Seed:TrainerEmail", "coach@example.com"), ("Seed:TrainerPassword", "first-password")));
        await TrainerSeeder.SeedAsync(_provider,
            Config(("Seed:TrainerEmail", "other@example.com"), ("Seed:TrainerPassword", "second-password")));

        var trainer = WithDb(db => db.UserByEmail("coach@example.com").Single());
        Assert.Equal(originalHash, trainer.PasswordHash);
        Assert.Equal(0, WithDb(db => db.UserByEmail("other@example.com").Count()));
    }

    [Fact]
    public async Task Unconfigured_seed_is_a_silent_noop()
    {
        await TrainerSeeder.SeedAsync(_provider, Config());

        Assert.False(WithDb(db => db.TrainerAccountExistsAsync()).Result);
    }

    [Fact]
    public async Task Half_configured_seed_fails_startup()
    {
        await Assert.ThrowsAsync<InvalidOperationException>(() =>
            TrainerSeeder.SeedAsync(_provider, Config(("Seed:TrainerEmail", "coach@example.com"))));
        await Assert.ThrowsAsync<InvalidOperationException>(() =>
            TrainerSeeder.SeedAsync(_provider, Config(("Seed:TrainerPassword", "pw"))));
    }
}
