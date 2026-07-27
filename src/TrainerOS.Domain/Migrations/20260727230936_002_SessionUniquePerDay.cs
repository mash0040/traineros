using Microsoft.EntityFrameworkCore.Migrations;

#nullable disable

namespace TrainerOS.Domain.Migrations
{
    /// <inheritdoc />
    public partial class _002_SessionUniquePerDay : Migration
    {
        /// <inheritdoc />
        protected override void Up(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.CreateIndex(
                name: "IX_workout_sessions_client_id_performed_on_program_day_id",
                table: "workout_sessions",
                columns: new[] { "client_id", "performed_on", "program_day_id" },
                unique: true,
                filter: "program_day_id IS NOT NULL");
        }

        /// <inheritdoc />
        protected override void Down(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.DropIndex(
                name: "IX_workout_sessions_client_id_performed_on_program_day_id",
                table: "workout_sessions");
        }
    }
}
