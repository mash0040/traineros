using Microsoft.EntityFrameworkCore.Migrations;

#nullable disable

namespace TrainerOS.Domain.Migrations
{
    /// <inheritdoc />
    public partial class _003_UserWeightUnit : Migration
    {
        /// <inheritdoc />
        protected override void Up(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.AddColumn<string>(
                name: "weight_unit",
                table: "users",
                type: "text",
                nullable: false,
                defaultValue: "lb");
        }

        /// <inheritdoc />
        protected override void Down(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.DropColumn(
                name: "weight_unit",
                table: "users");
        }
    }
}
