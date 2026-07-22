using Isopoh.Cryptography.Argon2;

namespace TrainerOS.Api.Auth;

// api.md §POST /api/auth/login: Argon2id comparison for the trainer's password.
// Hashes are PHC-encoded strings ($argon2id$...) so parameters travel with the hash.
public static class Passwords
{
    public static string Hash(string password)
        => Argon2.Hash(password, type: Argon2Type.HybridAddressing);

    public static bool Verify(string password, string hash)
        => Argon2.Verify(hash, password);
}
