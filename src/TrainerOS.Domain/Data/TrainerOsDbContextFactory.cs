using Microsoft.EntityFrameworkCore;
using Microsoft.EntityFrameworkCore.Design;

namespace TrainerOS.Domain.Data;

// Design-time only (dotnet ef migrations ...). Never used at runtime; the connection
// string matches the docker-compose dev database and is not a secret.
public sealed class TrainerOsDbContextFactory : IDesignTimeDbContextFactory<TrainerOsDbContext>
{
    public TrainerOsDbContext CreateDbContext(string[] args)
    {
        var options = new DbContextOptionsBuilder<TrainerOsDbContext>()
            .UseNpgsql("Host=localhost;Port=5432;Database=traineros;Username=traineros;Password=traineros")
            .Options;

        return new TrainerOsDbContext(options);
    }
}
